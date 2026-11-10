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

  it('applies RegExp and string replacements in order', () => {
    const layout = configured({
      replace: [
        [/a/g, 'b'],
        ['c', 'd'],
      ],
    });
    assert.strictEqual(layout.map('aac'), 'bbd/__object__');
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
