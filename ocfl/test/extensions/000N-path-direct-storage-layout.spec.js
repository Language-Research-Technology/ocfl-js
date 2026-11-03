import assert from 'node:assert';
import { extensions } from '../../src/index.ts';

const { PathDirectStorageLayout } = extensions;

describe('PathDirectStorageLayout class', () => {
  it('can map valid URIs', () => {
    const layout = new PathDirectStorageLayout();
    const cases = [
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
    const layout = new PathDirectStorageLayout();
    const cases = [
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
    const layout = new PathDirectStorageLayout();
    const cases = [
      'https://www.ausnc.org.au/corpora/md/__object__',
      //':/abc',
      //'/'
    ];
    for (const c of cases) {
      console.log(c);
      assert.throws(() => console.log(layout.map(c)));
    }
  });

  it('can omit schema', () => {
    const layout = new PathDirectStorageLayout({ omitScheme: true });
    const cases = [
      ['https://www.ausnc.org.au/corpora', 'www.ausnc.org.au/corpora/__object__'],
      ['doi:10.3897/rio.8.e93937', '10.3897/rio.8.e93937/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });

  it('can replace prefix', () => {
    const layout = new PathDirectStorageLayout({
      replace: [
        ['https://www.ausnc.org.au', 'ausnc'],
        [/(.+)doi\.org/, ''],
      ],
    });
    const cases = [
      ['https://www.ausnc.org.au/corpora', 'ausnc/corpora/__object__'],
      ['https://doi.org/10.3897/rio.8.e93937', '10.3897/rio.8.e93937/__object__'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });

  it('can use custom suffix', () => {
    const layout = new PathDirectStorageLayout({ suffix: '' });
    const cases = [
      ['https://www.ausnc.org.au/corpora', 'https_www.ausnc.org.au/corpora'],
      ['https://www.ausnc.org.au/corpora/', 'https_www.ausnc.org.au/corpora'],
    ];
    for (const c of cases) {
      assert.strictEqual(layout.map(c[0]), c[1]);
    }
  });
});
