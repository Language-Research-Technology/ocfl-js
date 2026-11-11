import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStorageRoot, type OcflObject, openStorageRoot, type StorageRoot } from '../src/index.ts';
import { SPEC_EX_FULL, SPEC_EX_FULL_ID, writeSpecExFullRoot, writeVersions } from './helpers/storage-roots.ts';

const textOf = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe('reading the files of an object', () => {
  let tempdir: string;
  let root: StorageRoot;

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-read-files-'));
    root = await createStorageRoot(path.join(tempdir, 'root'), { layout: { extensionName: '0002-flat-direct-storage-layout' } });
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  describe('of the OCFL fixture object', () => {
    let object: OcflObject;
    const stored = (contentPath: string) => fs.promises.readFile(path.join(SPEC_EX_FULL, contentPath));

    before(async () => {
      const rootPath = path.join(tempdir, 'spec-ex-full-root');
      await writeSpecExFullRoot(rootPath);
      object = await (await openStorageRoot(rootPath)).open(SPEC_EX_FULL_ID);
    });

    it('gives the size of a file in bytes', async () => {
      assert.strictEqual(await object.head.files.get('foo/bar.xml')!.size(), 272);
      assert.strictEqual(await object.head.files.get('empty2.txt')!.size(), 0);
    });

    it('reads a file as text', async () => {
      assert.strictEqual(await object.head.files.get('foo/bar.xml')!.text(), (await stored('v2/content/foo/bar.xml')).toString('utf8'));
    });

    it('reads a file as bytes', async () => {
      const bytes = await object.head.files.get('image.tiff')!.bytes();
      assert.ok(bytes instanceof Uint8Array);
      assert.ok((await stored('v1/content/image.tiff')).equals(bytes));
    });

    it('reads a file as a web stream', async () => {
      const stream = object.head.files.get('image.tiff')!.stream();
      assert.ok(stream instanceof ReadableStream);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        assert.ok(chunk instanceof Uint8Array);
        chunks.push(chunk);
      }
      assert.ok((await stored('v1/content/image.tiff')).equals(Buffer.concat(chunks)));
    });

    it('reads a file of an earlier version that a later version changed', async () => {
      const earlier = await object.versions.get(1)!.files.get('foo/bar.xml')!.bytes();
      assert.ok((await stored('v1/content/foo/bar.xml')).equals(earlier));
      assert.ok(!(await stored('v2/content/foo/bar.xml')).equals(earlier));
    });
  });

  it('reads the files of an older version after a later version changed or removed them', async () => {
    await writeVersions(root.path, 'older-version', [
      { 'changed.txt': 'original', 'removed.txt': 'removed later' },
      { 'changed.txt': 'replaced', 'removed.txt': null },
    ]);
    const object = await root.open('older-version');
    const contents = async (number: number) =>
      Object.fromEntries(await Promise.all([...object.versions.get(number)!.files].map(async ([logicalPath, file]) => [logicalPath, await file.text()])));
    assert.deepStrictEqual(await contents(1), { 'changed.txt': 'original', 'removed.txt': 'removed later' });
    assert.deepStrictEqual(await contents(2), { 'changed.txt': 'replaced' });
  });

  it('reads text as UTF-8', async () => {
    await writeVersions(root.path, 'utf8', [{ 'a.txt': new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]) }]);
    const file = (await root.open('utf8')).head.files.get('a.txt')!;
    assert.strictEqual(await file.text(), 'héllo');
    assert.strictEqual(await file.size(), 6);
  });

  it('shows nothing of where a file is stored', async () => {
    await writeVersions(root.path, 'stored-where', [{ 'a.txt': 'abc' }]);
    const file = (await root.open('stored-where')).head.files.get('a.txt')!;
    assert.deepStrictEqual(Object.keys(file), ['path', 'digest']);
    assert.ok(!JSON.stringify(file).includes('content'));
  });

  describe('a byte range', () => {
    let object: OcflObject;
    before(async () => {
      await writeVersions(root.path, 'ranges', [{ 'a.txt': 'abcdef' }]);
      object = await root.open('ranges');
    });
    const read = (range?: { start?: number; end?: number }) => textOf(object.head.files.get('a.txt')!.stream(range));

    for (const [name, range, expected] of [
      ['from start to end, with the end included', { start: 1, end: 3 }, 'bcd'],
      ['from a start to the end of the file', { start: 4 }, 'ef'],
      ['from the beginning of the file to an end', { end: 1 }, 'ab'],
      ['of the first byte', { start: 0, end: 0 }, 'a'],
      ['of the last byte', { start: 5, end: 5 }, 'f'],
      ['that ends at the last byte', { start: 3, end: 5 }, 'def'],
      ['that ends past the end of the file', { start: 3, end: 99 }, 'def'],
      ['that starts past the end of the file', { start: 6 }, ''],
      ['with neither end', {}, 'abcdef'],
      ['that is left out', undefined, 'abcdef'],
    ] as const) {
      it(`reads a range ${name}`, async () => {
        assert.strictEqual(await read(range), expected);
      });
    }

    for (const [name, range] of [
      ['that starts after it ends', { start: 3, end: 1 }],
      ['with a negative start', { start: -1 }],
      ['with a fractional end', { end: 1.5 }],
    ] as const) {
      it(`throws RangeError for a range ${name}`, () => {
        assert.throws(() => object.head.files.get('a.txt')!.stream(range), RangeError);
      });
    }
  });

  describe('a stored file that is missing', () => {
    let object: OcflObject;
    before(async () => {
      const objectRoot = await writeVersions(root.path, 'missing-content', [{ 'a.txt': 'abc', 'b.txt': 'kept' }]);
      await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
      object = await root.open('missing-content');
    });

    it('does not stop the object opening or its other files being read', async () => {
      assert.deepStrictEqual([...object.head.files.keys()].sort(), ['a.txt', 'b.txt']);
      assert.strictEqual(await object.head.files.get('b.txt')!.text(), 'kept');
    });

    it('surfaces as an error on the stream when it is read', async () => {
      const stream = object.head.files.get('a.txt')!.stream();
      assert.ok(stream instanceof ReadableStream);
      await assert.rejects(textOf(stream), { code: 'ENOENT' });
    });

    it('rejects reading its size, text or bytes', async () => {
      const file = object.head.files.get('a.txt')!;
      await assert.rejects(file.size(), { code: 'ENOENT' });
      await assert.rejects(file.text(), { code: 'ENOENT' });
      await assert.rejects(file.bytes(), { code: 'ENOENT' });
    });
  });
});
