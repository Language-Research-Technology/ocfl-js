import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { after, before, describe, it } from 'node:test';
import { createStorageRoot, type OcflFile, type OcflObject, openStorageRoot, type StorageRoot } from '../src/index.ts';
import { ocflError, rejection } from './helpers/ocfl-error.ts';
import { SPEC_EX_FULL, SPEC_EX_FULL_ID, writeSpecExFullRoot, writeVersions } from './helpers/storage-roots.ts';

/** How many of this process's file descriptors are open on `filePath` */
const timesOpen = (filePath: string) => {
  const target = fs.realpathSync(filePath);
  return fs.readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`) === target;
    } catch {
      return false;
    }
  }).length;
};

/** Every read of `file` rejects as an invalid object that names it as missing, caused by the file system error `code` */
async function assertEveryReadMissing(file: OcflFile, code: string) {
  for (const read of [() => file.stream(), () => file.size(), () => file.text(), () => file.bytes()]) {
    const error = await rejection(read(), 'INVALID_OBJECT');
    assert.ok(error.message.includes(`${file.path},`), error.message);
    assert.match(error.message, /is missing/);
    assert.strictEqual((error.cause as NodeJS.ErrnoException).code, code);
  }
}

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

    it('reads a file as a Node stream', async () => {
      const stream = await object.head.files.get('image.tiff')!.stream();
      assert.ok(stream instanceof Readable);
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
    const read = async (range?: { start?: number; end?: number }) => text(await object.head.files.get('a.txt')!.stream(range));

    for (const [name, range, expected] of [
      ['from start to end, with the end included', { start: 1, end: 3 }, 'bcd'],
      ['from a start to the end of the file', { start: 4 }, 'ef'],
      ['from the beginning of the file to an end', { end: 1 }, 'ab'],
      ['of the first byte', { start: 0, end: 0 }, 'a'],
      ['of the last byte', { start: 5, end: 5 }, 'f'],
      ['that ends at the last byte', { start: 3, end: 5 }, 'def'],
      ['that ends past the end of the file', { start: 3, end: 99 }, 'def'],
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
      ['that starts past the end of the file', { start: 6 }],
    ] as const) {
      it(`rejects with RangeError a range ${name}`, async () => {
        await assert.rejects(object.head.files.get('a.txt')!.stream(range), RangeError);
      });
    }

    for (const [name, range, message] of [
      ['with an unknown key', { strat: 1 }, /^file\.stream has no option 'strat'\.$/],
      ['with two unknown keys', { start: 1, strat: 1, signal: undefined }, /^file\.stream has no option 'strat' or 'signal'\.$/],
      ['that is a string', 'bytes=0-1', /^Options must be an object, such as \{ start: 0, end: 1023 \}, not 'bytes=0-1'$/],
      ['that is null', null, /^Options must be an object, such as \{ start: 0, end: 1023 \}, not null$/],
    ] as const) {
      it(`rejects with TypeError a range ${name}`, async () => {
        await assert.rejects(object.head.files.get('a.txt')!.stream(range as never), (e) => e instanceof TypeError && message.test(e.message));
      });
    }
  });

  describe('a byte range of an empty file', () => {
    let file: OcflFile;
    before(async () => {
      await writeVersions(root.path, 'empty-range', [{ 'empty.txt': '' }]);
      file = (await root.open('empty-range')).head.files.get('empty.txt')!;
    });

    it('reads nothing when the range is left out or has neither end', async () => {
      assert.strictEqual(await text(await file.stream()), '');
      assert.strictEqual(await text(await file.stream({})), '');
    });

    it('rejects with RangeError a range with a start', async () => {
      await assert.rejects(file.stream({ start: 0 }), RangeError);
    });
  });

  describe('a stream', () => {
    let objectRoot: string;
    let object: OcflObject;
    before(async () => {
      objectRoot = await writeVersions(root.path, 'held-open', [{ 'a.txt': 'abcdef', 'b.txt': 'abc' }]);
      object = await root.open('held-open');
    });

    it('reads in full a stored file removed after it opened', async () => {
      const stream = await object.head.files.get('a.txt')!.stream();
      await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
      assert.strictEqual(await text(stream), 'abcdef');
    });

    it('closes the stored file when it is destroyed before its end', async () => {
      const stream = await object.head.files.get('b.txt')!.stream({ end: 0 });
      assert.strictEqual(timesOpen(path.join(objectRoot, 'v1/content/b.txt')), 1);
      stream.destroy();
      await once(stream, 'close');
      assert.strictEqual(timesOpen(path.join(objectRoot, 'v1/content/b.txt')), 0);
    });

    it('closes the stored file when it rejects a range', async () => {
      await assert.rejects(object.head.files.get('b.txt')!.stream({ start: 3 }), RangeError);
      assert.strictEqual(timesOpen(path.join(objectRoot, 'v1/content/b.txt')), 0);
    });
  });

  describe('a stored file that cannot be read', { skip: process.getuid?.() === 0 }, () => {
    let file: OcflFile;
    before(async () => {
      const objectRoot = await writeVersions(root.path, 'unreadable-content', [{ 'a.txt': 'abc' }]);
      await fs.promises.chmod(path.join(objectRoot, 'v1/content/a.txt'), 0o000);
      file = (await root.open('unreadable-content')).head.files.get('a.txt')!;
    });

    it('rejects streaming, reading its size, text or bytes with the file system error', async () => {
      await assert.rejects(file.size(), { code: 'EACCES' });
      await assert.rejects(file.stream(), { code: 'EACCES' });
      await assert.rejects(file.text(), { code: 'EACCES' });
      await assert.rejects(file.bytes(), { code: 'EACCES' });
    });
  });

  describe('a stored file that is a directory', () => {
    let file: OcflFile;
    let objectRoot: string;
    before(async () => {
      objectRoot = await writeVersions(root.path, 'directory-content', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
      await fs.promises.mkdir(path.join(objectRoot, 'v1/content/a.txt'));
      file = (await root.open('directory-content')).head.files.get('a.txt')!;
    });

    it('rejects streaming, reading its size, text or bytes as an invalid object', async () => {
      await assert.rejects(file.stream(), ocflError('INVALID_OBJECT'));
      await assert.rejects(file.size(), ocflError('INVALID_OBJECT'));
      await assert.rejects(file.text(), ocflError('INVALID_OBJECT'));
      await assert.rejects(file.bytes(), ocflError('INVALID_OBJECT'));
    });

    it('says it is not a file, not that it is missing', async () => {
      const error = await rejection(file.size(), 'INVALID_OBJECT');
      assert.match(error.message, /is not a file/);
      assert.doesNotMatch(error.message, /missing/);
    });

    it('does not leave it open', async () => {
      await assert.rejects(file.stream(), ocflError('INVALID_OBJECT'));
      assert.strictEqual(timesOpen(path.join(objectRoot, 'v1/content/a.txt')), 0);
    });

    it('refuses a range with an unknown key before opening it', async () => {
      await assert.rejects(file.stream({ strat: 1 } as never), TypeError);
      assert.strictEqual(timesOpen(path.join(objectRoot, 'v1/content/a.txt')), 0);
    });
  });

  describe('a stored file that is a named pipe or a socket', () => {
    let server: net.Server;
    after(() => server?.close());

    it('rejects reading a named pipe as not a file, without waiting for a writer', { timeout: 5000 }, async () => {
      const objectRoot = await writeVersions(root.path, 'fifo-content', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
      execFileSync('mkfifo', [path.join(objectRoot, 'v1/content/a.txt')]);
      const file = (await root.open('fifo-content')).head.files.get('a.txt')!;
      for (const read of [() => file.stream(), () => file.size(), () => file.text(), () => file.bytes()]) {
        const error = await rejection(read(), 'INVALID_OBJECT');
        assert.match(error.message, /is not a file/);
      }
    });

    it('rejects reading a socket as not a file', async () => {
      const objectRoot = await writeVersions(root.path, 'socket-content', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
      server = net.createServer();
      await new Promise<void>((resolve) => server.listen(path.join(objectRoot, 'v1/content/a.txt'), resolve));
      const file = (await root.open('socket-content')).head.files.get('a.txt')!;
      for (const read of [() => file.stream(), () => file.size(), () => file.text(), () => file.bytes()]) {
        const error = await rejection(read(), 'INVALID_OBJECT');
        assert.match(error.message, /is not a file/);
      }
    });
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

    it('rejects streaming, reading its size, text or bytes as an invalid object, caused by the file system error', async () => {
      await assertEveryReadMissing(object.head.files.get('a.txt')!, 'ENOENT');
    });

    it('rejects reading a stored file whose content directory is a file as missing', async () => {
      const objectRoot = await writeVersions(root.path, 'content-is-a-file', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, 'v1/content'), { recursive: true });
      await fs.promises.writeFile(path.join(objectRoot, 'v1/content'), '');
      await assertEveryReadMissing((await root.open('content-is-a-file')).head.files.get('a.txt')!, 'ENOTDIR');
    });

    it('rejects an invalid range before it opens the stored file', async () => {
      await assert.rejects(object.head.files.get('a.txt')!.stream({ start: 3, end: 1 }), RangeError);
    });
  });
});
