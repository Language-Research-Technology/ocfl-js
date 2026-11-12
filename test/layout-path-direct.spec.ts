import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createLayout } from '../src/extensions/index.ts';

const NAME = '000N-path-direct-storage-layout';
const configured = (params: Record<string, unknown>) => createLayout({ extensionName: NAME, ...params });

describe('the 000N path direct layout', () => {
  it('can map valid URIs', () => {
    const layout = createLayout({ extensionName: NAME });
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
    }
    // no scheme urls, eg: www.ausnc.org.au/corpora/md
  });
  // replace: array of regex or string
  // suffix
  //
  it('can map valid arcp ids', () => {
    const layout = createLayout({ extensionName: NAME });
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
    const layout = createLayout({ extensionName: NAME });
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
    const layout = createLayout({ extensionName: NAME });
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
    const layout = createLayout({ extensionName: NAME });
    for (const id of ['arcp://x;../y', 'https://h/a/.\t./b', 'https://h/a/.\n/b', 'file:..', 'doi:../x']) {
      assert.throws(() => layout.map(id), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, JSON.stringify(id));
    }
  });

  it('checks the id after its replacements', () => {
    const layout = configured({ replace: [['x', '..']] });
    assert.throws(() => layout.map('a/x/b'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
  });

  it('still maps ids whose segments only start with dots', () => {
    const layout = createLayout({ extensionName: NAME });
    assert.strictEqual(layout.map('a/..b/.c'), 'a/..b/.c/__object__');
  });

  it('rejects a suffix with a . or .. segment', () => {
    for (const suffix of ['/../x', '..', '/./x']) {
      assert.throws(() => configured({ suffix }), TypeError, suffix);
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
        ['https://doi.org', ''],
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
    const layout = configured({ suffix: '.obj' });
    const cases: [string, string][] = [
      ['https://www.ausnc.org.au/corpora', 'https_www.ausnc.org.au/corpora/.obj'],
      ['https://www.ausnc.org.au/corpora/', 'https_www.ausnc.org.au/corpora/.obj'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });

  it('rejects a suffix with no path segment, which would let one object root sit inside another', () => {
    for (const suffix of ['', '/', '//']) {
      assert.throws(() => configured({ suffix }), TypeError, JSON.stringify(suffix));
    }
  });

  it('rejects an id that maps to a path with the suffix part-way through', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'a/__object__/b'],
      [{}, '__object__/b'],
      [{}, 'a/__object__/'],
      [{}, 'https://h/a/__object__/b'],
      [{}, 'https://h/a/__object__/?q'],
      [{ suffix: '.obj' }, 'a/.obj/b'],
      [{ suffix: '.obj' }, 'a/.obj/'],
      [{ suffix: '/x/y' }, 'a/x/y/b'],
      [{ suffix: '/x/x' }, 'a/x'],
      [{ replace: [['OBJ', '__object__']] }, 'a/OBJ/b'],
      [{ suffix: '.obj', replace: [['OBJ', '.obj']] }, 'a/OBJ/b'],
    ];
    for (const [params, id] of cases) {
      const layout = configured(params);
      assert.throws(() => layout.map(id), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, `${JSON.stringify(params)} ${id}`);
    }
  });

  it('compares the id with the suffix ignoring case and Unicode normalisation form', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'a/__OBJECT__/b'],
      [{}, 'a/__Object__'],
      [{ suffix: '.obj' }, 'a/.OBJ/b'],
      [{ suffix: '.obj' }, 'a/.OBJ'],
      [{ suffix: '/caf\u00e9' }, 'a/cafe\u0301/b'],
      [{ suffix: '/cafe\u0301' }, 'a/CAF\u00c9'],
    ];
    for (const [params, id] of cases) {
      assert.throws(() => configured(params).map(id), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, `${JSON.stringify(params)} ${id}`);
    }
  });

  it('treats a suffix with extra slashes as the same suffix', () => {
    for (const suffix of ['/__object__/', '__object__', '//__object__']) {
      const layout = configured({ suffix });
      assert.strictEqual(layout.map('a/b'), 'a/b/__object__', suffix);
      assert.throws(() => layout.map('a/__object__/b'), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, suffix);
      assert.throws(() => layout.map('a/__object__'), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, suffix);
    }
    assert.strictEqual(configured({ suffix: 'x//y' }).map('a'), 'a/x/y');
    assert.throws(() => configured({ suffix: 'x//y' }).map('a/x/y/b'), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
  });

  it('still maps ids that hold the suffix only within a segment', () => {
    assert.strictEqual(createLayout({ extensionName: NAME }).map('a/x__object__/b'), 'a/x__object__/b/__object__');
    assert.strictEqual(configured({ suffix: '.obj' }).map('a.obj/b'), 'a.obj/b/.obj');
  });

  it('maps an id that only starts with another id beside it, not inside it', () => {
    const layout = createLayout({ extensionName: NAME });
    assert.strictEqual(layout.map('a'), 'a/__object__');
    assert.strictEqual(layout.map('a/b'), 'a/b/__object__');
  });

  it('rejects an id that maps to a path segment over 255 UTF-8 bytes, and maps one of exactly 255', () => {
    const layout = createLayout({ extensionName: NAME });
    const cases: [Record<string, unknown>, string][] = [
      [{}, `a/${'x'.repeat(256)}/b`],
      [{}, `a/${'é'.repeat(128)}`],
      [{}, `https://h/${'é'.repeat(50)}`],
      [{}, `https://${'x'.repeat(250)}.org/a`],
      [{ replace: [['X', 'x'.repeat(256)]] }, 'a/X'],
      [{ suffix: `/${'x'.repeat(256)}` }, 'a'],
    ];
    for (const [params, id] of cases) {
      assert.throws(() => configured(params).map(id), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, `${JSON.stringify(params)} ${id}`);
    }
    assert.strictEqual(layout.map(`a/${'x'.repeat(255)}`), `a/${'x'.repeat(255)}/__object__`);
    assert.strictEqual(layout.map(`${'é'.repeat(127)}x`), `${'é'.repeat(127)}x/__object__`);
    assert.strictEqual(layout.map(`https://h/${'é'.repeat(42)}xxx`), `https_h/${'%C3%A9'.repeat(42)}xxx/__object__`);
  });
});
