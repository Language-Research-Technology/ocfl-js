import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { before, describe, it } from 'node:test';
import type { StorageRoot, WriteContent } from '../src/index.ts';
import {
  assertHolds,
  createObject,
  DETAILS,
  encode,
  objectRootOf,
  readInventory,
  sha512,
  storedFiles,
  streamOf,
  textFiles,
  useTempRoots,
} from './helpers/drafts.ts';
import { ocflError } from './ocfl-error.ts';

describe('writing a file to a draft', () => {
  const temp = useTempRoots('ocfl-draft-write-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  describe('what it accepts', () => {
    const inputs: [string, () => WriteContent][] = [
      ['a string', () => 'héllo'],
      ['a Uint8Array', () => encode('héllo')],
      ['a Buffer', () => Buffer.from('héllo')],
      [
        'a Node Readable',
        () => {
          const source = path.join(temp.dir, `source-${objectCount}`);
          fs.writeFileSync(source, 'héllo');
          return fs.createReadStream(source);
        },
      ],
      ['a web ReadableStream', () => streamOf('héllo')],
      [
        'an async generator of strings and bytes',
        async function* () {
          yield 'hé';
          yield encode('l');
          yield Buffer.from('l');
          yield 'o';
        },
      ],
    ];

    for (const [name, content] of inputs) {
      it(`stores the bytes of ${name} under their digest`, async () => {
        const id = newId();
        const object = await root.create(id, DETAILS, async (draft) => {
          await draft.write('a', content());
        });
        const inventory = await assertHolds(root, object, { a: 'héllo' });
        assert.deepStrictEqual(inventory.manifest, { [sha512('héllo')]: ['v1/content/a'] });
        assert.strictEqual(object.head.files.get('a')!.digest, sha512('héllo'));
      });
    }

    it('stores only the bytes a partial view covers', async () => {
      const bytes = encode('0123456789ABCDEF');
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('part', new Uint8Array(bytes.buffer, 5, 5));
      });
      await assertHolds(root, object, { part: '56789' });
    });

    it('stores a file with no content', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('empty', '');
      });
      await assertHolds(root, object, { empty: '' });
    });

    const unsupported: [string, () => unknown, RegExp][] = [
      ['a number', () => 42, /Unsupported data type: \[object Number\]/],
      ['a plain object', () => ({ text: 'héllo' }), /Unsupported data type: \[object Object\]/],
      ['nothing', () => undefined, /Unsupported data type: \[object Undefined\]/],
      ['an ArrayBuffer', () => encode('héllo').buffer, /Unsupported data type: \[object ArrayBuffer\]/],
      ['a Blob', () => new Blob(['héllo']), /Unsupported data type: \[object Blob\]/],
      ['a DataView', () => new DataView(encode('héllo').buffer), /Unsupported data type: \[object DataView\]/],
      ['a Uint16Array', () => new Uint16Array(4), /Unsupported data type: \[object Uint16Array\]/],
      ['an iterable yielding something other than bytes or strings', () => Readable.from([{ text: 'héllo' }]), /Unsupported data type: \[object Object\]/],
    ];

    for (const [name, content, message] of unsupported) {
      it(`rejects ${name} with a TypeError and records nothing`, async () => {
        const object = await root.create(newId(), DETAILS, async (draft) => {
          await assert.rejects(draft.write('bad', content() as never), (e) => e instanceof TypeError && message.test(e.message));
          await draft.write('ok', 'ok');
        });
        await assertHolds(root, object, { ok: 'ok' });
        assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/ok']);
      });
    }

    it('stores the same content written as different types once', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('string', 'héllo');
        await draft.write('bytes', encode('héllo'));
        await draft.write('buffer', Buffer.from('héllo'));
        await draft.write('stream', streamOf('héllo'));
      });
      const inventory = await assertHolds(root, object, { string: 'héllo', bytes: 'héllo', buffer: 'héllo', stream: 'héllo' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('héllo')]: ['v1/content/string'] });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/string']);
    });

    it('stores a file read from disk as text, as bytes and as a stream', async () => {
      const source = path.join(import.meta.dirname, 'shared/test-data/test_input.txt');
      const content = await fs.promises.readFile(source);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('test.txt', content.toString());
        await draft.write('a/test.txt', content);
        await draft.write('b/test.txt', Readable.toWeb(fs.createReadStream(source)) as ReadableStream<Uint8Array>);
      });
      const text = content.toString();
      await assertHolds(root, object, { 'test.txt': text, 'a/test.txt': text, 'b/test.txt': text });
    });
  });

  describe('replacing a file', () => {
    it('replaces a file of the head version', async () => {
      const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/x', 'changed');
      });
      await assertHolds(root, updated, { a: 'a', 'd/x': 'changed' });
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { a: 'a', 'd/x': 'x' });
    });

    it('replaces a file written earlier in the same draft, storing only the last content', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'first');
        await draft.write('a', 'second');
      });
      const inventory = await assertHolds(root, object, { a: 'second' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('second')]: ['v1/content/a'] });
    });
  });

  describe('a path that would be both a file and a directory', () => {
    const files = { a: 'a', 'd/x': 'x' };

    for (const [name, target] of [
      ['inside a file', 'a/b'],
      ['deep inside a file', 'a/b/c'],
      ['onto a directory', 'd'],
      ['onto a doubled-slash form of a directory', './/d'],
    ] as const) {
      it(`throws FILE_EXISTS ${name} of the head version, writing no version`, async () => {
        const object = await createObject(root, newId(), files);
        const returned = await object.update(DETAILS, async (draft) => {
          await assert.rejects(draft.write(target, 'new'), ocflError('FILE_EXISTS'));
        });
        assert.strictEqual(returned, object);
        assert.strictEqual((await readInventory(objectRootOf(root, object.id))).head, 'v1');
        await assertHolds(root, object, files);
      });
    }

    it('throws FILE_EXISTS onto a directory written in the same draft, keeping its files', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('d/x', 'x');
        await assert.rejects(draft.write('d', 'new'), ocflError('FILE_EXISTS'));
        await assert.rejects(draft.write('d/x/y', 'new'), ocflError('FILE_EXISTS'));
      });
      await assertHolds(root, object, { 'd/x': 'x' });
    });
  });

  describe('logical paths', () => {
    it('stores a path in its normalised form', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('./raw//1.wav', 'wav');
        await draft.write('./d//x', 'x');
        await draft.write('./e/./y/', 'y');
        await assert.rejects(draft.write('d', 'new'), ocflError('FILE_EXISTS'));
        await assert.rejects(draft.write('e/y/z', 'new'), ocflError('FILE_EXISTS'));
        await draft.write('d/x', 'replaced');
      });
      await assertHolds(root, object, { 'raw/1.wav': 'wav', 'd/x': 'replaced', 'e/y': 'y' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/d/x', 'v1/content/e/y', 'v1/content/raw/1.wav']);
    });

    for (const [name, logicalPath] of [
      ['the empty path ""', ''],
      ['the empty path "."', '.'],
      ['the empty path "./"', './'],
      ['a path that leaves the object', '../escape.txt'],
      ['a path that leaves the object part-way', 'a/../../escape.txt'],
      ['a path with .. that stays in the object', 'a/../b.txt'],
      ['a path that leaves the object with a backslash', '..\\escape.txt'],
      ['an absolute path', '/abs.txt'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, writing no version`, async () => {
        const object = await createObject(root, newId(), { a: 'a' });
        const returned = await object.update(DETAILS, async (draft) => {
          await assert.rejects(draft.write(logicalPath, 'new'), ocflError('INVALID_LOGICAL_PATH'));
        });
        assert.strictEqual(returned, object);
        await assertHolds(root, object, { a: 'a' });
        assert.ok(!fs.existsSync(path.join(temp.dir, 'escape.txt')));
        assert.ok(!fs.existsSync(path.join(root.path, 'escape.txt')));
      });
    }

    it('accepts a name that merely starts with two dots', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('..notes.txt', 'x');
        await draft.write('dir/..hidden', 'y');
      });
      await assertHolds(root, object, { '..notes.txt': 'x', 'dir/..hidden': 'y' });
    });
  });
});
