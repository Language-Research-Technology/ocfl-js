import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, before, describe, it, mock } from 'node:test';
import type { Draft, OcflObject, StorageRoot } from '../src/index.ts';
import {
  assertHolds,
  assertVersionValid,
  createObject,
  DETAILS,
  encode,
  objectRootOf,
  readInventory,
  snapshot,
  storedFiles,
  streamOf,
  textFiles,
  useTempRoots,
  workspaceOf,
} from './helpers/drafts.ts';
import { withFsFailure } from './helpers/fs-failures.ts';
import { makeTree } from './helpers/import-sources.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { writeFiles } from './helpers/storage-roots.ts';

const CONCURRENCY_LIMIT = 10;
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

/** Counts the files `fs.createReadStream` has open, and with `copies` those `fs.promises.copyFile` is copying, returning the most open at once */
function trackOpenFiles({ copies = false } = {}) {
  const createReadStream = fs.createReadStream;
  const copyFile = fs.promises.copyFile;
  let open = 0;
  let maxOpen = 0;
  mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = createReadStream(...args);
    maxOpen = Math.max(maxOpen, ++open);
    stream.once('close', () => open--);
    return stream;
  });
  if (copies) {
    mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
      maxOpen = Math.max(maxOpen, ++open);
      try {
        return await copyFile(from, to);
      } finally {
        open--;
      }
    });
  }
  return () => maxOpen;
}

describe('importing into a draft', () => {
  const temp = useTempRoots('ocfl-draft-import-');
  let root: StorageRoot;
  let count = 0;
  const newId = () => `object-${count++}`;

  /** Writes `files`, keyed by relative path, under a new directory and returns it */
  async function newSource(files: Record<string, string>) {
    const source = path.join(temp.dir, `source-${count++}`);
    await writeFiles(source, files);
    return source;
  }

  /** Asserts that the object is still the one version `files` made, with nothing left in the workspace */
  async function assertUnchanged(object: OcflObject, files: Record<string, string>) {
    assert.strictEqual((await readInventory(objectRootOf(root, object.id))).head, 'v1');
    assert.ok(!fs.existsSync(path.join(objectRootOf(root, object.id), 'v2')));
    assert.deepStrictEqual(await snapshot(workspaceOf(root)), {});
    await assertHolds(root, await root.open(object.id), files);
  }

  async function assertNothingCreated(id: string) {
    assert.ok(!fs.existsSync(objectRootOf(root, id)));
    assert.deepStrictEqual(await snapshot(workspaceOf(root)), {});
  }

  before(async () => {
    root = await temp.newRoot();
  });
  afterEach(() => {
    mock.restoreAll();
  });

  describe('where the source goes', () => {
    const tree = { 'a.txt': 'a', 'sub/b.txt': 'b', '.hidden': 'h' };

    it("puts a directory's contents at the top without a target", async () => {
      const source = await newSource(tree);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
      });
      await assertHolds(root, object, { 'a.txt': 'a', 'sub/b.txt': 'b', '.hidden': 'h' });
    });

    it("puts a directory's contents under the target", async () => {
      const source = await newSource(tree);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source, 'x/y');
      });
      await assertHolds(root, object, { 'x/y/a.txt': 'a', 'x/y/sub/b.txt': 'b', 'x/y/.hidden': 'h' });
    });

    it('keeps a file at its own name without a target', async () => {
      const source = await newSource(tree);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(path.join(source, 'sub', 'b.txt'));
      });
      await assertHolds(root, object, { 'b.txt': 'b' });
    });

    it('puts a file at the target', async () => {
      const source = await newSource(tree);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(path.join(source, 'a.txt'), 'docs/renamed.txt');
      });
      await assertHolds(root, object, { 'docs/renamed.txt': 'a' });
    });

    it('normalises the target', async () => {
      const source = await newSource(tree);
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(path.join(source, 'a.txt'), './docs//a.txt');
        await draft.import(path.join(source, 'sub'), 'more/');
      });
      await assertHolds(root, object, { 'docs/a.txt': 'a', 'more/b.txt': 'b' });
    });

    it('imports a tree of text, empty and binary files byte for byte', async () => {
      const source = path.join(FIXTURES, 'ocfl/1.1/content/spec-ex-full/v3');
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
      });
      assert.deepStrictEqual([...object.head.files.keys()].sort(), ['empty2.txt', 'foo/bar.xml', 'image.tiff']);
      for (const file of ['empty2.txt', 'foo/bar.xml', 'image.tiff']) {
        assert.deepStrictEqual(Buffer.from(await object.head.files.get(file)!.bytes()), await fs.promises.readFile(path.join(source, file)));
      }
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), [
        'v1/content/empty2.txt',
        'v1/content/foo/bar.xml',
        'v1/content/image.tiff',
      ]);
      await assertVersionValid(objectRootOf(root, object.id), 'v1');
    });

    it('imports several sources into one version', async () => {
      const full = path.join(FIXTURES, 'ocfl/1.1/content/spec-ex-full/v3');
      const diffPaths = path.join(FIXTURES, 'ocfl/1.1/content/spec-ex-diff-paths/v1');
      const source = await newSource({ 'metadata.json': '{}', 'data/a/a.txt': 'data a', 'data/a/aa/aa.txt': 'data aa', 'data/b/b.txt': 'data b' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(full);
        await draft.import(diffPaths);
        await draft.import(path.join(source, 'metadata.json'), 'metadata.json');
        await draft.import(path.join(source, 'data'), 'data');
      });
      assert.deepStrictEqual([...object.versions.keys()], [1]);
      assert.deepStrictEqual(
        [...object.head.files.keys()].sort(),
        [
          'a file.wxy',
          'another file.xyz',
          'data/a/a.txt',
          'data/a/aa/aa.txt',
          'data/b/b.txt',
          'empty2.txt',
          'foo/bar.xml',
          'image.tiff',
          'metadata.json',
        ].sort(),
      );
      assert.strictEqual(await object.head.files.get('data/a/aa/aa.txt')!.text(), 'data aa');
      assert.strictEqual(await object.head.files.get('a file.wxy')!.text(), await fs.promises.readFile(path.join(diffPaths, 'a file.wxy'), 'utf8'));
      await assertVersionValid(objectRootOf(root, object.id), 'v1');
    });

    it('adds a version to an object that has files, keeping them', async () => {
      const object = await createObject(root, newId(), { 'test.txt': 'test' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.import(path.join(FIXTURES, 'ocfl/1.1/content/spec-ex-full/v3'));
      });
      assert.deepStrictEqual([...updated.head.files.keys()].sort(), ['empty2.txt', 'foo/bar.xml', 'image.tiff', 'test.txt']);
      assert.strictEqual(await fs.promises.readFile(path.join(objectRootOf(root, object.id), 'v1/content/test.txt'), 'utf8'), 'test');
      assert.strictEqual(await fs.promises.readFile(path.join(objectRootOf(root, object.id), 'v2/content/empty2.txt'), 'utf8'), '');
    });

    it('records the message and user of the update on the version', async () => {
      const source = await newSource(tree);
      const details = { message: 'Nightly sync', user: { name: 'importer', address: 'https://example.org/importer' } };
      const object = await root.create(newId(), details, async (draft) => {
        await draft.import(source);
      });
      assert.strictEqual(object.head.message, 'Nightly sync');
      assert.deepStrictEqual(object.head.user, details.user);
      const { versions } = await readInventory(objectRootOf(root, object.id));
      assert.strictEqual(versions.v1!.message, 'Nightly sync');
      assert.deepStrictEqual(versions.v1!.user, details.user);
    });
  });

  describe('a target that is not a path in the object', () => {
    for (const [name, target] of [
      ['the empty target ""', ''],
      ['the empty target "."', '.'],
      ['the empty target "./"', './'],
      ['a target that leaves the object', '../escape.txt'],
      ['a target that leaves the object part-way', 'a/../../escape.txt'],
      ['a target with .. that stays in the object', 'a/../b'],
      ['an absolute target', '/abs.txt'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, for a directory as for a file, writing no version`, async () => {
        const source = await newSource({ 'a.txt': 'new' });
        const object = await createObject(root, newId(), { a: 'a' });
        const returned = await object.update(DETAILS, async (draft) => {
          await assert.rejects(draft.import(source, target), ocflError('INVALID_LOGICAL_PATH'));
          await assert.rejects(draft.import(path.join(source, 'a.txt'), target), ocflError('INVALID_LOGICAL_PATH'));
        });
        assert.strictEqual(returned, object);
        await assertUnchanged(object, { a: 'a' });
        assert.ok(!fs.existsSync(path.join(temp.dir, 'escape.txt')));
        assert.ok(!fs.existsSync(path.join(root.path, 'escape.txt')));
      });
    }

    it('throws before any source is read', async () => {
      const missing = path.join(temp.dir, 'no-such-source');
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.import(missing, '../escape.txt');
        }),
        ocflError('INVALID_LOGICAL_PATH'),
      );
      await assertNothingCreated(id);
    });
  });

  describe('importing over what the draft has', () => {
    it('replaces files at the same paths and leaves the others', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'old a', 'kept.txt': 'kept', 'sub/b.txt': 'old b', 'sub/kept.txt': 'kept too' });
      const source = await newSource({ 'a.txt': 'new a', 'sub/b.txt': 'new b', 'added.txt': 'added' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.import(source);
      });
      await assertHolds(root, updated, { 'a.txt': 'new a', 'kept.txt': 'kept', 'sub/b.txt': 'new b', 'sub/kept.txt': 'kept too', 'added.txt': 'added' });
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), {
        'a.txt': 'old a',
        'kept.txt': 'kept',
        'sub/b.txt': 'old b',
        'sub/kept.txt': 'kept too',
      });
    });

    it('replaces a file an earlier import of the same draft put there, storing only the last content', async () => {
      const first = await newSource({ 'a.txt': 'first a', 'only-first.txt': 'first' });
      const second = await newSource({ 'a.txt': 'second a' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(first);
        await draft.import(second);
      });
      await assertHolds(root, object, { 'a.txt': 'second a', 'only-first.txt': 'first' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/a.txt', 'v1/content/only-first.txt']);
    });

    it('replaces a file imported under another spelling of the same path', async () => {
      const source = await newSource({ 'a.txt': 'a' });
      const other = await newSource({ 'other.txt': 'other' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
        await draft.import(path.join(other, 'other.txt'), './a.txt');
      });
      await assertHolds(root, object, { 'a.txt': 'other' });
    });

    it('replaces a file written earlier in the same draft', async () => {
      const source = await newSource({ 'a.txt': 'imported' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a.txt', 'written');
        await draft.write('b.txt', 'kept');
        await draft.import(source);
      });
      await assertHolds(root, object, { 'a.txt': 'imported', 'b.txt': 'kept' });
    });

    it('keeps the content of a file it replaces when it also imports that content elsewhere', async () => {
      const source = await newSource({ 'a.txt': 'two', 'b.txt': 'one' });
      const reversed = await newSource({ 'a.txt': 'one', 'b.txt': 'two' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a.txt', 'one');
        await draft.write('b.txt', 'two');
        await draft.import(source, 'x');
        await draft.import(source);
        await draft.import(reversed);
        await draft.import(source);
      });
      await assertHolds(root, object, { 'a.txt': 'two', 'b.txt': 'one', 'x/a.txt': 'two', 'x/b.txt': 'one' });
    });
  });

  describe('a path that would be both a file and a directory', () => {
    const files = { a: 'a', 'd/x': 'x' };

    it('throws FILE_EXISTS for a file inside an existing file, importing nothing', async () => {
      const source = await newSource({ 'a/inner.txt': 'inner', 'ok.txt': 'ok' });
      const object = await createObject(root, newId(), files);
      const returned = await object.update(DETAILS, async (draft) => {
        await assert.rejects(draft.import(source), ocflError('FILE_EXISTS'));
      });
      assert.strictEqual(returned, object);
      await assertUnchanged(object, files);
    });

    it('throws FILE_EXISTS for a file onto a directory, creating no version', async () => {
      const source = await newSource({ 'new.txt': 'new' });
      const object = await createObject(root, newId(), files);
      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          await draft.import(path.join(source, 'new.txt'), 'd');
        }),
        ocflError('FILE_EXISTS'),
      );
      await assertUnchanged(object, files);
    });

    it('throws FILE_EXISTS for a file where an earlier import of the same draft put a directory', async () => {
      const source = await newSource({ 'a.txt': 'a', 'sub/b.txt': 'b' });
      const file = await newSource({ 'sub.txt': 'not a directory' });
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.import(source);
          await draft.import(path.join(file, 'sub.txt'), 'sub');
        }),
        ocflError('FILE_EXISTS'),
      );
      await assertNothingCreated(id);
    });
  });

  describe('a source that is not regular files and directories', () => {
    it('throws UNSUPPORTED_FILE_TYPE for a directory containing a symlink, creating nothing', async () => {
      const source = await newSource({ 'a.txt': 'a' });
      await fs.promises.symlink(path.join(source, 'a.txt'), path.join(source, 'link.txt'));
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.import(source);
        }),
        ocflError('UNSUPPORTED_FILE_TYPE'),
      );
      await assertNothingCreated(id);
    });

    it('throws UNSUPPORTED_FILE_TYPE for a symlink deep in a directory', async () => {
      const source = await newSource({ 'a.txt': 'a', 'sub/deeper/b.txt': 'b' });
      await fs.promises.symlink(path.join(source, 'sub'), path.join(source, 'sub/deeper/link'));
      const object = await createObject(root, newId(), { a: 'a' });
      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          await draft.import(source, 'in');
        }),
        ocflError('UNSUPPORTED_FILE_TYPE'),
      );
      await assertUnchanged(object, { a: 'a' });
    });

    it('throws UNSUPPORTED_FILE_TYPE for a source that is itself a symlink', async () => {
      const source = await newSource({ 'a.txt': 'a' });
      const dirLink = path.join(temp.dir, `link-${count++}`);
      const fileLink = path.join(temp.dir, `link-${count++}`);
      await fs.promises.symlink(source, dirLink);
      await fs.promises.symlink(path.join(source, 'a.txt'), fileLink);
      const object = await createObject(root, newId(), { a: 'a' });
      const returned = await object.update(DETAILS, async (draft) => {
        await assert.rejects(draft.import(dirLink), ocflError('UNSUPPORTED_FILE_TYPE'));
        await assert.rejects(draft.import(fileLink, 'b'), ocflError('UNSUPPORTED_FILE_TYPE'));
      });
      assert.strictEqual(returned, object);
      await assertUnchanged(object, { a: 'a' });
    });
  });

  describe('a file that cannot be imported', () => {
    it('throws SOURCE_CHANGED itself when a source changes between being read and being copied', async () => {
      const source = await newSource({ 'a.txt': 'hashed' });
      const file = path.join(source, 'a.txt');
      const object = await createObject(root, newId(), { 'a.txt': 'v1' });
      const copyFile = fs.promises.copyFile;
      mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
        await fs.promises.writeFile(file, 'changed before the copy');
        return copyFile(from, to);
      });
      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          await draft.import(source);
        }),
        (e) => ocflError('SOURCE_CHANGED')(e) && !(e instanceof AggregateError) && (e as Error).message.includes(file),
      );
      mock.restoreAll();
      await assertUnchanged(object, { 'a.txt': 'v1' });
    });

    it('throws the failure of the first file that fails, in listing order', async () => {
      const source = await newSource({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
      const id = newId();
      const copyFile = fs.promises.copyFile;
      mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
        if (path.basename(from) !== 'a.txt') {
          await fs.promises.appendFile(from, ' changed');
        }
        return copyFile(from, to);
      });
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.import(source);
        }),
        (e) => ocflError('SOURCE_CHANGED')(e) && (e as Error).message.includes(path.join(source, 'b.txt')),
      );
      mock.restoreAll();
      await assertNothingCreated(id);
    });

    it('fails a directory import with the file system error when one of its files cannot be read', { skip: process.getuid?.() === 0 }, async () => {
      const source = await newSource({ 'ok.txt': 'ok', 'locked.txt': 'locked' });
      await fs.promises.chmod(path.join(source, 'locked.txt'), 0o000);
      const id = newId();
      try {
        await assert.rejects(
          root.create(id, DETAILS, async (draft) => {
            await draft.import(source);
          }),
          (e) => !(e instanceof AggregateError) && (e as NodeJS.ErrnoException).code === 'EACCES',
        );
      } finally {
        await fs.promises.chmod(path.join(source, 'locked.txt'), 0o600);
      }
      await assertNothingCreated(id);
    });

    describe('when the callback carries on after the failure', () => {
      const lockB = (source: string) => fs.promises.chmod(path.join(source, 'b.txt'), 0o000);
      const changeBBeforeItsCopy = async (source: string) => {
        const copyFile = fs.promises.copyFile;
        mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
          if (from === path.join(source, 'b.txt')) {
            await fs.promises.appendFile(from, ' changed');
          }
          return copyFile(from, to);
        });
      };
      const failures: [string, Record<string, string>, (source: string) => Promise<void>, (e: unknown) => boolean, skip?: boolean][] = [
        ['a file that cannot be read', {}, lockB, (e) => (e as NodeJS.ErrnoException).code === 'EACCES', process.getuid?.() === 0],
        ['a symlink', {}, (source) => fs.promises.symlink(path.join(source, 'a.txt'), path.join(source, 'link')), ocflError('UNSUPPORTED_FILE_TYPE')],
        ['a file inside an existing file', { 'file/inner.txt': 'inner' }, async () => {}, ocflError('FILE_EXISTS')],
        ['a file that changes while it is copied', {}, changeBBeforeItsCopy, ocflError('SOURCE_CHANGED')],
      ];

      for (const [name, extra, breakSource, isFailure, skip = false] of failures) {
        it(`leaves the draft as it was before an import that fails on ${name}`, { skip }, async () => {
          const source = await newSource({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', ...extra });
          const object = await createObject(root, newId(), { 'in/a.txt': 'old a', 'in/file': 'a file', 'kept.txt': 'kept' });
          const updated = await object.update(DETAILS, async (draft) => {
            await draft.write('in/c.txt', 'drafted c');
            await breakSource(source);
            await assert.rejects(draft.import(source, 'in'), isFailure);
            mock.restoreAll();
            await draft.write('after.txt', 'after');
          });
          await fs.promises.chmod(path.join(source, 'b.txt'), 0o600);
          assert.strictEqual(updated.head.number, 2);
          await assertHolds(root, updated, { 'in/a.txt': 'old a', 'in/c.txt': 'drafted c', 'in/file': 'a file', 'kept.txt': 'kept', 'after.txt': 'after' });
          assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/after.txt', 'v2/content/in/c.txt']);
          assert.deepStrictEqual(await snapshot(workspaceOf(root)), {});
        });
      }

      it('fails the update when a copied file cannot be put in place, as the draft cannot be put back', async () => {
        const source = await newSource({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
        const id = newId();
        await assert.rejects(
          root.create(id, DETAILS, async (draft) => {
            await withFsFailure(
              'rename',
              (_from, to) => to.endsWith(path.join('content', 'in', 'b.txt')),
              () => assert.rejects(draft.import(source, 'in'), { code: 'EIO' }),
            );
          }),
          { code: 'EIO' },
        );
        await assertNothingCreated(id);
      });
    });

    it('throws the file system error for a source that does not exist', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      const returned = await object.update(DETAILS, async (draft) => {
        await assert.rejects(draft.import(path.join(temp.dir, 'no-such-source')), { code: 'ENOENT' });
      });
      assert.strictEqual(returned, object);
      await assertUnchanged(object, { a: 'a' });
    });
  });

  describe('content the object already holds', () => {
    it('copies nothing for content an earlier version holds', async () => {
      const source = await newSource({ 'a.txt': 'same' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
      });
      await fs.promises.writeFile(path.join(source, 'b.txt'), 'same');
      const copies = mock.method(fs.promises, 'copyFile');
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.import(source);
      });
      assert.strictEqual(copies.mock.calls.filter((call) => String(call.arguments[0]).startsWith(source)).length, 0);
      await assertHolds(root, updated, { 'a.txt': 'same', 'b.txt': 'same' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), []);
    });

    it('stores no content file for a file imported twice under other names', async () => {
      const source = path.join(FIXTURES, 'test_input.txt');
      const text = await fs.promises.readFile(source, 'utf8');
      const object = await createObject(root, newId(), { 'test.txt': text });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.import(source);
        await draft.import(source, 'test2.txt');
      });
      const inventory = await assertHolds(root, updated, { 'test.txt': text, 'test_input.txt': text, 'test2.txt': text });
      assert.deepStrictEqual(Object.values(inventory.manifest), [['v1/content/test.txt']]);
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), []);
    });

    it('writes no version when an import brings nothing new', async () => {
      const source = await newSource({ 'a.txt': 'a', 'sub/b.txt': 'b' });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
      });
      const returned = await object.update(DETAILS, async (draft) => {
        await draft.import(source);
      });
      assert.strictEqual(returned, object);
      await assertUnchanged(object, { 'a.txt': 'a', 'sub/b.txt': 'b' });
    });
  });

  describe('the limit on open files', () => {
    it('keeps open files within one limit however deep the tree is', async () => {
      const source = path.join(temp.dir, `tree-${count++}`);
      await makeTree(source, 3, 4);
      const maxOpen = trackOpenFiles();
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
      });
      assert.strictEqual(object.head.files.size, 64);
      assert.ok(maxOpen() <= CONCURRENCY_LIMIT, `${maxOpen()} files were open at once`);
    });

    it('keeps reads and copies within one limit across concurrent imports in one draft', async () => {
      const first = path.join(temp.dir, `tree-${count++}`);
      const second = path.join(temp.dir, `tree-${count++}`);
      await makeTree(first, 2, 8);
      await makeTree(second, 2, 8);
      const maxOpen = trackOpenFiles({ copies: true });
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await Promise.all([draft.import(first, 'a'), draft.import(second, 'b')]);
      });
      assert.strictEqual(object.head.files.size, 128);
      assert.ok(maxOpen() <= CONCURRENCY_LIMIT, `${maxOpen()} files were open at once`);
      assert.ok(maxOpen() > 1, 'files were read one at a time');
    });
  });

  describe('operations started together', () => {
    it('take effect in call order, whichever source is quicker to read', async () => {
      const large = await newSource({ 'a.txt': 'L'.repeat(2_000_000), 'large.txt': 'large' });
      const small = await newSource({ 'a.txt': 'small' });
      const largeFirst = await root.create(newId(), DETAILS, async (draft) => {
        await Promise.all([draft.import(large), draft.import(small)]);
      });
      const smallFirst = await root.create(newId(), DETAILS, async (draft) => {
        await Promise.all([draft.import(small), draft.import(large)]);
      });
      await assertHolds(root, largeFirst, { 'a.txt': 'small', 'large.txt': 'large' });
      assert.strictEqual((await smallFirst.head.files.get('a.txt')!.text()).length, 2_000_000);
      await assertVersionValid(objectRootOf(root, smallFirst.id), 'v1');
    });

    it('give the same result as awaiting an import and writes one by one', async () => {
      const source = await newSource({ 'a.txt': 'imported a', 'b.txt': 'imported b', 'sub/c.txt': 'imported c' });
      const steps: ((draft: Draft) => Promise<void>)[] = [
        (draft) => draft.write('a.txt', 'written before'),
        (draft) => draft.import(source),
        (draft) => draft.write('b.txt', 'written after'),
        (draft) => draft.import(path.join(source, 'sub/c.txt'), 'b.txt/../never'),
        (draft) => draft.import(path.join(source, 'sub/c.txt'), 'd.txt'),
      ];
      const settle = (step: Promise<void>) => step.catch(() => {});
      const sequential = await root.create(newId(), DETAILS, async (draft) => {
        for (const step of steps) {
          await settle(step(draft));
        }
      });
      const concurrent = await root.create(newId(), DETAILS, async (draft) => {
        await Promise.all(steps.map((step) => settle(step(draft))));
      });
      const expected = { 'a.txt': 'imported a', 'b.txt': 'written after', 'sub/c.txt': 'imported c', 'd.txt': 'imported c' };
      await assertHolds(root, sequential, expected);
      await assertHolds(root, concurrent, expected);
    });
  });

  describe('a draft whose update is over or not yet settled', () => {
    it('throws an Error from import once the update has finished, changing nothing', async () => {
      const source = await newSource({ 'late.txt': 'late' });
      let leaked: Draft | undefined;
      const object = await root.create(newId(), DETAILS, async (draft) => {
        leaked = draft;
        await draft.write('a', 'a');
      });
      const before = await snapshot(root.path);
      await assert.rejects(leaked!.import(source), (e) => e instanceof Error && !ocflError('INVALID_LOGICAL_PATH')(e) && !(e instanceof TypeError));
      await assert.rejects(leaked!.import(source, 'target'), Error);
      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertHolds(root, object, { a: 'a' });
    });

    it('throws an Error from import once the update has failed', async () => {
      const source = await newSource({ 'late.txt': 'late' });
      let leaked: Draft | undefined;
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          leaked = draft;
          throw new Error('callback failed');
        }),
        { message: 'callback failed' },
      );
      await assert.rejects(leaked!.import(source), Error);
      await assertNothingCreated(id);
    });

    it('rejects an update whose callback returns while an import is still running, writing nothing', async () => {
      const source = await newSource({ 'a.txt': 'a', 'sub/b.txt': 'b' });
      const object = await createObject(root, newId(), { kept: 'kept' });
      let floating: Promise<void> | undefined;
      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          floating = draft.import(source);
        }),
        /Unfinished operations detected/,
      );
      await floating?.catch(() => {});
      await assertUnchanged(object, { kept: 'kept' });
    });
  });

  describe('concurrent operations in one draft', () => {
    const ROUNDS = 20;

    for (let round = 0; round < ROUNDS; round++) {
      describe(`round ${round}`, () => {
        it('importing a directory stores duplicate files once, including in subdirectories', async () => {
          const source = await newSource({
            'a.txt': 'identical',
            'b.txt': 'identical',
            'sub/c.txt': 'identical',
            'sub/deeper/d.txt': 'identical',
            'sub/other.txt': 'other',
          });
          const object = await root.create(newId(), DETAILS, async (draft) => {
            await draft.import(source);
          });
          const inventory = await assertHolds(root, object, {
            'a.txt': 'identical',
            'b.txt': 'identical',
            'sub/c.txt': 'identical',
            'sub/deeper/d.txt': 'identical',
            'sub/other.txt': 'other',
          });
          assert.strictEqual(Object.keys(inventory.manifest).length, 2);
          assert.strictEqual((await storedFiles(objectRootOf(root, object.id), 'v1')).length, 2);
        });

        const identicalWrites: [string, (draft: Draft, logicalPath: string, index: number) => Promise<void>][] = [
          ['strings', (draft, p) => draft.write(p, 'same')],
          ['buffers', (draft, p) => draft.write(p, encode('same'))],
          ['streams', (draft, p) => draft.write(p, streamOf('same'))],
          ['a mix of strings and streams', (draft, p, i) => draft.write(p, i % 2 ? streamOf('same') : 'same')],
        ];

        for (const [kind, write] of identicalWrites) {
          it(`concurrent writes of identical ${kind} leave one content file`, async () => {
            const object = await root.create(newId(), DETAILS, async (draft) => {
              await Promise.all(['a', 'b', 'c', 'd'].map((p, i) => write(draft, p, i)));
            });
            await assertHolds(root, object, { a: 'same', b: 'same', c: 'same', d: 'same' });
            assert.strictEqual((await storedFiles(objectRootOf(root, object.id), 'v1')).length, 1);
          });
        }

        it('a failed write rejects, leaves nothing behind, and a later write of that content stores it', async () => {
          const id = newId();
          const failed = path.join(workspaceOf(root), id, 'v1/content/a');
          const object = await root.create(id, DETAILS, async (draft) => {
            const [first, second] = await withFsFailure('rename', failed, () => Promise.allSettled([draft.write('a', 'same'), draft.write('b', 'same')]));
            assert.strictEqual(first.status, 'rejected');
            assert.strictEqual(second.status, 'fulfilled');
          });
          await assertHolds(root, object, { b: 'same' });
          assert.deepStrictEqual(await storedFiles(objectRootOf(root, id), 'v1'), ['v1/content/b']);
        });
      });
    }
  });
});
