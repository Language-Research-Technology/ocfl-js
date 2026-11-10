import assert from 'node:assert';
import { describe, it } from 'node:test';
import { storageLayout } from '../../src/index.ts';

const NAME = '000N-path-direct-storage-layout';
const configured = (params: Record<string, unknown>) => storageLayout({ extensionName: NAME, ...params });

describe('the 000N path direct layout', () => {
  it('can map valid URIs', () => {
    const layout = storageLayout(NAME);
    const cases: [string, string][] = [
      ['https://www.ausnc.org.au/corpora', 'https_www.ausnc.org.au/corpora/__object__'],
      ['https://www.ausnc.org.au/corpora/md', 'https_www.ausnc.org.au/corpora/md/__object__'],
      ['https://www.ausnc.org.au/corpora/md/a', 'https_www.ausnc.org.au/corpora/md/a/__object__'],
      ['https://www.ausnc.org.au/corpora/md/a/b.jpg', 'https_www.ausnc.org.au/corpora/md/a/b.jpg/__object__'],
      ['//www.ausnc.org.au/corpora', 'www.ausnc.org.au/corpora/__object__'],
      ['/www.ausnc.org.au/corpora', 'www.ausnc.org.au/corpora/__object__'],
      ['www.ausnc.org.au/corpora', 'www.ausnc.org.au/corpora/__object__'],
      ['file:///temp/a/b', 'temp/a/b/__object__'],
      ['file://temp/a/b', 'temp/a/b/__object__'],
      ['https://doi.org/10.3897/rio.8.e93937', 'https_doi.org/10.3897/rio.8.e93937/__object__'],
      ['doi:/10.3897/rio.8.e93937', 'doi/10.3897/rio.8.e93937/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
      //assert.strictEqual(layout.map(c[0].replace(/(^http:\/\/)|(^\/+)/, '')), c[1]);
    }
    // no scheme urls, eg: www.ausnc.org.au/corpora/md
  });
  // replace: array of regex or string
  // suffix
  //
  it('can map valid arcp ids', () => {
    const layout = storageLayout(NAME);
    const cases: [string, string][] = [
      ['arcp://name,md/corpus/root/a', 'arcp_name_md/corpus/root/a/__object__'],
      ['arcp://uuid,1234567/corpus/root/a', 'arcp_uuid_1234567/corpus/root/a/__object__'],
      ['arcp://ni,sha-256;f4OxZX_x_FO5LcGBSKHWXfwtSx-j1ncoSt3SABJtkGk/', 'arcp_ni_sha-256/f4OxZX_x_FO5LcGBSKHWXfwtSx-j1ncoSt3SABJtkGk/__object__'],
      ['arcp://doi,12345/abc/', 'arcp_doi_12345/abc/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });
  it('can catch invalid urls', () => {
    const layout = storageLayout(NAME);
    const cases = [
      'https://www.ausnc.org.au/corpora/md/__object__',
      //':/abc',
      //'/'
    ];
    for (const c of cases) {
      assert.throws(() => layout.map(c), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    }
  });

  it('rejects an id with a . or .. segment instead of normalising it', () => {
    const layout = storageLayout(NAME);
    for (const id of [
      '../x',
      'a/../../x',
      'a/./b',
      '.',
      '..',
      'a/..',
      'https://h/a/../b',
      'https://h/a/%2e%2E/b',
      'https://h/a/.%2e/b',
      'https://h/a\\..\\b',
    ]) {
      assert.throws(() => layout.map(id), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, id);
    }
  });

  it('rejects a dot segment that only appears once the URL is parsed', () => {
    const layout = storageLayout(NAME);
    for (const id of ['arcp://x;../y', 'https://h/a/.\t./b', 'https://h/a/.\n/b', 'file:..', 'doi:../x']) {
      assert.throws(() => layout.map(id), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, JSON.stringify(id));
    }
  });

  it('checks the id after its replacements', () => {
    const layout = configured({ replace: [['x', '..']] });
    assert.throws(() => layout.map('a/x/b'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
  });

  it('still maps ids whose segments only start with dots', () => {
    const layout = storageLayout(NAME);
    assert.strictEqual(layout.map('a/..b/.c'), 'a/..b/.c/__object__');
  });

  it('rejects a suffix with a . or .. segment', () => {
    for (const suffix of ['/../x', '..', '/./x']) {
      assert.throws(() => configured({ suffix }), { name: 'OcflError', code: 'INVALID_LAYOUT_CONFIG' }, suffix);
    }
  });

  it('can omit schema', () => {
    const layout = configured({ omitScheme: true });
    const cases: [string, string][] = [
      ['https://www.ausnc.org.au/corpora', 'www.ausnc.org.au/corpora/__object__'],
      ['doi:10.3897/rio.8.e93937', '10.3897/rio.8.e93937/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });

  it('can replace prefix', () => {
    const layout = configured({
      replace: [
        ['https://www.ausnc.org.au', 'ausnc'],
        [/(.+)doi\.org/, ''],
      ],
    });
    const cases: [string, string][] = [
      ['https://www.ausnc.org.au/corpora', 'ausnc/corpora/__object__'],
      ['https://doi.org/10.3897/rio.8.e93937', '10.3897/rio.8.e93937/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });

  it('can use custom suffix', () => {
    const layout = configured({ suffix: '' });
    const cases: [string, string][] = [
      ['https://www.ausnc.org.au/corpora', 'https_www.ausnc.org.au/corpora'],
      ['https://www.ausnc.org.au/corpora/', 'https_www.ausnc.org.au/corpora'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });
});
