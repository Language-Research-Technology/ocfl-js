import assert from 'node:assert';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';
import type { Draft, OcflObject, StorageRoot } from '../src/index.ts';
import {
  assertHolds,
  assertRefuses,
  assertVersionValid,
  assertWritesNothing,
  createObject,
  DETAILS,
  objectRootOf,
  readInventory,
  sha512,
  snapshot,
  storedFiles,
  textFiles,
  useTempRoots,
} from './helpers/drafts.ts';
import { writeFiles, writeInventory } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

describe('reinstating in a draft', () => {
  const temp = useTempRoots('ocfl-draft-reinstate-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  type Step = (draft: Draft) => Promise<void>;

  /** Creates an object whose first version holds `files`, then makes one more version for each of `changes` */
  async function objectWith(files: Record<string, string>, ...changes: Step[]): Promise<OcflObject> {
    let object = await createObject(root, newId(), files);
    for (const change of changes) {
      object = await object.update(DETAILS, change);
    }
    return object;
  }

  /** Asserts that `operation` is refused with `code` in an update of `object`, and that the update writes nothing */
  async function assertRefused(object: OcflObject, operation: Step, code: 'FILE_EXISTS' | 'FILE_NOT_FOUND' | 'INVALID_LOGICAL_PATH') {
    await assertRefuses(root, object, operation, code);
  }

  describe('a file', () => {
    it('puts back a removed file as it was, storing no new content', async () => {
      const object = await objectWith({ 'a.txt': 'AAA', keep: 'KKK' }, (draft) => draft.remove('a.txt'));
      const objectRoot = objectRootOf(root, object.id);
      const v2 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        assert.strictEqual(await draft.reinstate('a.txt', 1), undefined);
      });
      const inventory = await assertHolds(root, updated, { 'a.txt': 'AAA', keep: 'KKK' });
      assert.strictEqual(updated.head.number, 3);
      assert.deepStrictEqual(inventory.manifest, v2.manifest);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v3'), []);
      assert.deepStrictEqual(inventory.versions.v1, v2.versions.v1);
      assert.deepStrictEqual(inventory.versions.v2, v2.versions.v2);
      assert.strictEqual(updated.head.files.get('a.txt')?.digest, sha512('AAA'));
    });

    for (const [version, expected] of [
      [1, 'ONE'],
      [2, 'TWO'],
    ] as const) {
      it(`puts back a changed file as it was in version ${version}`, async () => {
        const object = await objectWith(
          { a: 'ONE' },
          (draft) => draft.write('a', 'TWO'),
          (draft) => draft.write('a', 'THREE'),
        );
        const objectRoot = objectRootOf(root, object.id);
        const v3 = await readInventory(objectRoot);
        const updated = await object.update(DETAILS, (draft) => draft.reinstate('a', version));
        const inventory = await assertHolds(root, updated, { a: expected });
        assert.deepStrictEqual(inventory.manifest, v3.manifest);
        assert.deepStrictEqual(await storedFiles(objectRoot, 'v4'), []);
        assert.deepStrictEqual(await textFiles(updated.versions.get(3)!), { a: 'THREE' });
      });
    }

    it('leaves other files with the same content where they are', async () => {
      const object = await objectWith({ x: 'SAME' }, async (draft) => {
        await draft.remove('x');
        await draft.write('y', 'SAME');
      });
      const updated = await object.update(DETAILS, (draft) => draft.reinstate('x', 1));
      const inventory = await assertHolds(root, updated, { x: 'SAME', y: 'SAME' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('SAME')]: ['v1/content/x'] });
    });

    for (const spelling of ['./d//a.txt', 'd/./a.txt', 'd/a.txt/']) {
      it(`takes the path spelled ${spelling}`, async () => {
        const object = await objectWith({ 'd/a.txt': 'AAA', keep: 'KKK' }, (draft) => draft.write('d/a.txt', 'changed'));
        const updated = await object.update(DETAILS, (draft) => draft.reinstate(spelling, 1));
        await assertHolds(root, updated, { 'd/a.txt': 'AAA', keep: 'KKK' });
      });
    }
  });

  describe('a directory', () => {
    it('puts back every file that was below it, replacing files at the same path and keeping the rest', async () => {
      const object = await objectWith({ 'd/a': 'A1', 'd/b': 'B1', 'd/s/c': 'C1', 'd/same': 'S1', dx: 'X1', keep: 'KKK' }, async (draft) => {
        await draft.remove('d/a');
        await draft.write('d/b', 'B2');
        await draft.remove('d/s');
        await draft.write('d/new', 'NEW');
        await draft.write('d/s/other', 'OTHER');
        await draft.write('dx', 'X2');
      });
      const objectRoot = objectRootOf(root, object.id);
      const v2 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, (draft) => draft.reinstate('d', 1));
      const inventory = await assertHolds(root, updated, {
        'd/a': 'A1',
        'd/b': 'B1',
        'd/s/c': 'C1',
        'd/same': 'S1',
        'd/new': 'NEW',
        'd/s/other': 'OTHER',
        dx: 'X2',
        keep: 'KKK',
      });
      assert.deepStrictEqual(inventory.manifest, v2.manifest);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v3'), []);
    });

    it('puts back a file and a directory from an earlier version in one update', async () => {
      const object = await objectWith(
        { first: 'first' },
        async (draft) => {
          await draft.write('test.txt', 'test');
          await draft.write('bar/bar.xml', '<bar/>');
          await draft.write('bar/deep/baz.xml', '<baz/>');
        },
        async (draft) => {
          await draft.remove('test.txt');
          await draft.remove('bar');
        },
      );
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.reinstate('test.txt', 2);
        await draft.reinstate('bar', 2);
      });
      await assertHolds(root, updated, { first: 'first', 'test.txt': 'test', 'bar/bar.xml': '<bar/>', 'bar/deep/baz.xml': '<baz/>' });
      assert.strictEqual(updated.head.number, 4);
      for (const logicalPath of ['test.txt', 'bar/bar.xml', 'bar/deep/baz.xml']) {
        assert.strictEqual(updated.head.files.get(logicalPath)?.digest, updated.versions.get(2)?.files.get(logicalPath)?.digest);
      }
    });

    it('refuses the whole directory when one of its files clashes, changing nothing', async () => {
      const object = await createObject(root, newId(), { 'd/a': 'A1', 'd/b': 'B1' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/b', 'B2');
        await draft.remove('d/a');
        await draft.write('d/a/x', 'XXX');
        await assert.rejects(draft.reinstate('d', 1), ocflError('FILE_EXISTS'));
      });
      await assertHolds(root, updated, { 'd/a/x': 'XXX', 'd/b': 'B2' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/d/a/x', 'v2/content/d/b']);
    });
  });

  describe('the version', () => {
    /** Writes an object with an empty version for each of `names`, as another tool might, and opens it */
    async function objectWithVersions(id: string, names: string[]): Promise<OcflObject> {
      const objectRoot = objectRootOf(root, id);
      const version = { created: '2026-01-02T03:04:05Z', message: 'Made elsewhere', state: {}, user: { name: 'Another tool' } };
      await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
      await writeInventory(
        objectRoot,
        JSON.stringify({
          digestAlgorithm: 'sha512',
          head: names.at(-1),
          id,
          manifest: {},
          type: 'https://ocfl.io/1.1/spec/#inventory',
          versions: Object.fromEntries(names.map((name) => [name, version])),
        }),
      );
      return root.open(id);
    }

    it('is a number of object.versions, on an object whose version names are zero-padded', async () => {
      const id = newId();
      const second = await objectWithVersions(id, ['v001', 'v002']);
      const third = await second.update(DETAILS, async (draft) => {
        await draft.write('a', 'THREE');
        await draft.write('d/b', 'B3');
      });
      const fourth = await third.update(DETAILS, async (draft) => {
        await draft.write('a', 'FOUR');
        await draft.remove('d');
      });
      assert.deepStrictEqual([...fourth.versions.keys()], [1, 2, 3, 4]);
      const fifth = await fourth.update(DETAILS, async (draft) => {
        await draft.reinstate('a', 3);
        await draft.reinstate('d', 3);
        await assert.rejects(draft.reinstate('a', 2), ocflError('FILE_NOT_FOUND'));
        await assert.rejects(draft.reinstate('a', 5), ocflError('FILE_NOT_FOUND'));
      });
      assert.deepStrictEqual(await textFiles(fifth.head), { a: 'THREE', 'd/b': 'B3' });
      assert.deepStrictEqual(await textFiles((await root.open(id)).head), { a: 'THREE', 'd/b': 'B3' });
      const stored = await assertVersionValid(objectRootOf(root, id), 'v005');
      assert.strictEqual(stored.head, 'v005');
      assert.deepStrictEqual(stored.versions.v005?.state, stored.versions.v003?.state);
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, id), 'v005'), []);
    });

    for (const [name, change] of [
      ['a write', (draft: Draft) => draft.write('a', 'changed')],
      ['a removal', (draft: Draft) => draft.remove('a')],
      ['the removal of every file', (draft: Draft) => draft.clear()],
    ] as const) {
      it(`can be the latest, which undoes ${name} the draft made to that path, so no version is written`, async () => {
        const object = await objectWith({ a: 'ONE' }, (draft) => draft.write('a', 'TWO'));
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await change(draft);
            await draft.reinstate('a', 2);
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { a: 'TWO' });
      });
    }

    it('can be the latest, which puts back a file the draft renamed and leaves the new name', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a', 'b');
        await draft.reinstate('a', 1);
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
    });

    it('can be the latest, which undoes only the changes below the path', async () => {
      const object = await createObject(root, newId(), { 'd/a': 'A1', 'd/b': 'B1', other: 'O1' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/a', 'A2');
        await draft.remove('d/b');
        await draft.write('d/new', 'NEW');
        await draft.write('other', 'O2');
        await draft.reinstate('d', 1);
      });
      const inventory = await assertHolds(root, updated, { 'd/a': 'A1', 'd/b': 'B1', 'd/new': 'NEW', other: 'O2' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/d/new', 'v2/content/other']);
      assert.strictEqual(inventory.manifest[sha512('A2')], undefined);
    });

    for (const version of [3, 4, 99, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`throws FILE_NOT_FOUND for version ${version} of an object with two versions, writing nothing`, async () => {
        const object = await objectWith({ a: 'ONE' }, (draft) => draft.write('a', 'TWO'));
        await assertRefused(object, (draft) => draft.reinstate('a', version), 'FILE_NOT_FOUND');
      });
    }

    for (const [name, version, message] of [
      ['a version name', 'v1', /The version must be a number, such as 1, not 'v1'/],
      ['a numeric string', '1', /The version must be a number, such as 1, not '1'/],
      ['no version', undefined, /The version must be a number, such as 1, not undefined/],
      ['null', null, /The version must be a number, such as 1, not null/],
      ['a bigint', 1n, /The version must be a number, such as 1, not 1n/],
      ['a Number object', new Number(1), /The version must be a number, such as 1, not \[Number: 1\]/],
    ] as const) {
      it(`throws a TypeError for ${name} as the version, writing nothing`, async () => {
        const object = await objectWith({ a: 'ONE' }, (draft) => draft.write('a', 'TWO'));
        await assertWritesNothing(root, object, () =>
          object.update(DETAILS, async (draft) => {
            await assert.rejects(draft.reinstate('a', version as never), (e) => e instanceof TypeError && message.test(e.message));
          }),
        );
        await assertHolds(root, object, { a: 'TWO' });
      });
    }

    it('throws a TypeError for a version that is not a number before judging the path', async () => {
      const object = await createObject(root, newId(), { a: 'ONE' });
      await assertWritesNothing(root, object, () =>
        object.update(DETAILS, async (draft) => {
          await assert.rejects(draft.reinstate('', 'v1' as never), TypeError);
        }),
      );
    });

    it('throws FILE_NOT_FOUND for the version being made, keeping what the draft wrote', async () => {
      const object = await createObject(root, newId(), { a: 'ONE' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('a', 'TWO');
        await assert.rejects(draft.reinstate('a', 2), ocflError('FILE_NOT_FOUND'));
      });
      await assertHolds(root, updated, { a: 'TWO' });
    });

    for (const version of [1, 0]) {
      it(`throws FILE_NOT_FOUND for version ${version} while the object is being created`, async () => {
        const object = await root.create(newId(), DETAILS, async (draft) => {
          await draft.write('a', 'AAA');
          await assert.rejects(draft.reinstate('a', version), ocflError('FILE_NOT_FOUND'));
        });
        await assertHolds(root, object, { a: 'AAA' });
      });
    }
  });

  describe('a path that was not in the version', () => {
    for (const [name, logicalPath, version] of [
      ['a path no version had', 'missing', 1],
      ['a path only a later version had', 'later', 1],
      ['a path only an earlier version had', 'a', 2],
      ['a path that only starts with the name of a file', 'a.txt', 1],
      ['a path that only starts with the name of a directory', 'di', 1],
      ['a path below a file', 'a/b', 1],
    ] as const) {
      it(`throws FILE_NOT_FOUND for ${name}, writing nothing`, async () => {
        const object = await objectWith({ a: 'AAA', 'dir/x': 'XXX' }, async (draft) => {
          await draft.remove('a');
          await draft.write('later', 'LLL');
        });
        await assertRefused(object, (draft) => draft.reinstate(logicalPath, version), 'FILE_NOT_FOUND');
      });
    }
  });

  describe('a path that would be both a file and a directory', () => {
    it('throws FILE_EXISTS for a file where the draft now has a directory, removing nothing', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('a');
        await draft.write('a/x', 'XXX');
        await draft.write('b', 'BBB');
        await assert.rejects(draft.reinstate('a', 1), ocflError('FILE_EXISTS'));
      });
      await assertHolds(root, updated, { 'a/x': 'XXX', b: 'BBB' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/a/x', 'v2/content/b']);
    });

    it('puts the file back once the directory the draft wrote is removed, dropping its content', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('a');
        await draft.write('a/x', 'XXX');
        await draft.write('b', 'BBB');
        await assert.rejects(draft.reinstate('a', 1), ocflError('FILE_EXISTS'));
        await draft.remove('a');
        await draft.reinstate('a', 1);
      });
      await assertHolds(root, updated, { a: 'AAA', b: 'BBB' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/b']);
    });

    it('throws FILE_EXISTS for a file where a later version has a directory, writing nothing', async () => {
      const object = await objectWith({ x: 'file' }, async (draft) => {
        await draft.remove('x');
        await draft.write('x/y', 'y');
      });
      await assertRefused(object, (draft) => draft.reinstate('x', 1), 'FILE_EXISTS');
    });

    for (const logicalPath of ['d/x', 'd']) {
      it(`throws FILE_EXISTS reinstating ${logicalPath} when its files now lie below a file, changing nothing`, async () => {
        const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x', 'd/y': 'y' });
        const updated = await object.update(DETAILS, async (draft) => {
          await draft.remove('d');
          await draft.write('d', 'file');
          await assert.rejects(draft.reinstate(logicalPath, 1), ocflError('FILE_EXISTS'));
        });
        assert.strictEqual(updated.head.number, 2);
        await assertHolds(root, updated, { a: 'a', d: 'file' });
      });
    }
  });

  describe('an invalid path', () => {
    for (const [name, logicalPath] of [
      ['an empty path', ''],
      ['a path that is only a dot', '.'],
      ['a path that is only a dot and a slash', './'],
      ['a path that leaves the object', '../a'],
      ['a path with a .. segment', 'd/../a'],
      ['a path with a .. segment after a backslash', 'd\\..\\a'],
      ['an absolute path', '/a'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, writing nothing`, async () => {
        const object = await objectWith({ a: 'ONE', 'd/x': 'x' }, (draft) => draft.write('a', 'TWO'));
        await assertRefused(object, (draft) => draft.reinstate(logicalPath, 1), 'INVALID_LOGICAL_PATH');
      });
    }

    it('throws INVALID_LOGICAL_PATH for an invalid path even when the version does not exist', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await assertRefused(object, (draft) => draft.reinstate('', 7), 'INVALID_LOGICAL_PATH');
    });
  });

  describe('content the draft stored for a replaced file', () => {
    it('is removed when nothing else uses it', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('a', 'NEW');
        await draft.write('b', 'BBB');
        await draft.reinstate('a', 1);
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', b: 'BBB' });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/b']);
      assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
      assert.strictEqual(inventory.manifest[sha512('NEW')], undefined);
    });

    it('moves to a remaining copy', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('a', 'NEW');
        await draft.copy('a', 'c');
        await draft.reinstate('a', 1);
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', c: 'NEW' });
      assert.deepStrictEqual(inventory.manifest[sha512('NEW')], ['v2/content/c']);
    });

    it('is removed for every replaced file below a directory', async () => {
      const object = await createObject(root, newId(), { 'd/a': 'A1', 'd/b': 'B1' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/a', 'A2');
        await draft.write('d/b', 'B2');
        await draft.write('d/c', 'C2');
        await draft.reinstate('d', 1);
      });
      await assertHolds(root, updated, { 'd/a': 'A1', 'd/b': 'B1', 'd/c': 'C2' });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), ['v2/content/d/c']);
    });

    it('leaves the path free to be written again', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('a', 'NEW');
        await draft.reinstate('a', 1);
        await draft.remove('a');
        await draft.write('a', 'THREE');
      });
      const inventory = await assertHolds(root, updated, { a: 'THREE' });
      assert.deepStrictEqual(inventory.manifest[sha512('THREE')], ['v2/content/a']);
    });
  });

  describe('a path the head already has as it was', () => {
    for (const [name, logicalPath] of [
      ['a file', 'a'],
      ['a directory', 'd'],
    ] as const) {
      it(`writes no version for ${name}`, async () => {
        const object = await objectWith({ a: 'AAA', 'd/x': 'XXX', 'd/y': 'YYY' }, (draft) => draft.write('other', 'OOO'));
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await draft.reinstate(logicalPath, 1);
            await draft.reinstate(logicalPath, 2);
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { a: 'AAA', 'd/x': 'XXX', 'd/y': 'YYY', other: 'OOO' });
      });
    }
  });

  describe('a draft whose update has finished', () => {
    it('throws an Error from reinstate after the update was committed, changing nothing', async () => {
      let kept: Draft | undefined;
      const first = await createObject(root, newId(), { a: 'ONE' });
      const object = await first.update(DETAILS, async (draft) => {
        kept = draft;
        await draft.write('a', 'TWO');
      });
      const before = await snapshot(root.path);
      await assert.rejects(kept!.reinstate('a', 1), (e) => e instanceof Error && !('code' in e));
      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertHolds(root, object, { a: 'TWO' });
    });

    it('throws an Error from reinstate after the update was discarded', async () => {
      let kept: Draft | undefined;
      const object = await createObject(root, newId(), { a: 'ONE' });
      const failure = new Error('stop');
      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          kept = draft;
          await draft.write('a', 'TWO');
          throw failure;
        }),
        failure,
      );
      await assert.rejects(kept!.reinstate('a', 1), (e) => e instanceof Error && !('code' in e));
      assert.ok(!fs.existsSync(`${objectRootOf(root, object.id)}/v2`));
      await assertHolds(root, object, { a: 'ONE' });
    });

    it('rejects an update that ends while reinstate is still pending, leaving the object as it was', async () => {
      const object = await objectWith({ a: 'ONE' }, (draft) => draft.remove('a'));
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('b', 'BBB');
            void draft.reinstate('a', 1);
          }),
          /^Error: Unfinished operations detected/,
        ),
      );
      await assertHolds(root, object, {});
    });
  });
});
