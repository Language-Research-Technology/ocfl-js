import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Draft, OcflObject, StorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
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
  workspaceOf,
} from './helpers/drafts.ts';
import { writeFiles } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

/** What an object shows of itself and its versions, for comparing two views of one object */
async function described(object: OcflObject): Promise<unknown> {
  return {
    id: object.id,
    digestAlgorithm: object.digestAlgorithm,
    head: object.head.number,
    versions: await Promise.all(
      Array.from(object.versions.values(), async (version) => ({
        number: version.number,
        created: version.created,
        message: version.message,
        user: version.user,
        digests: Object.fromEntries(Array.from(version.files, ([logicalPath, file]) => [logicalPath, file.digest])),
        texts: await textFiles(version),
      })),
    ),
  };
}

describe('copying in a draft', () => {
  const temp = useTempRoots('ocfl-draft-copy-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  /** Asserts that `operation` is refused with `code` in an update of an object holding `files`, and that the update writes nothing */
  async function assertRefused(files: Record<string, string>, operation: (draft: Draft) => Promise<void>, code: 'FILE_EXISTS' | 'FILE_NOT_FOUND') {
    await assertRefuses(root, await createObject(root, newId(), files), operation, code);
  }

  describe('a file', () => {
    it('lists a committed file at the target, storing no new content', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'AAA', keep: 'KKK' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        assert.strictEqual(await draft.copy('a.txt', 'd/b.txt'), undefined);
      });
      const inventory = await assertHolds(root, updated, { 'a.txt': 'AAA', 'd/b.txt': 'AAA', keep: 'KKK' });
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.strictEqual(updated.head.files.get('d/b.txt')?.digest, sha512('AAA'));
    });

    it('lists a file written in the same draft at the target, storing its content once', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });

    it('replaces a file at the target, dropping content the draft stored only for it', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/a']);
    });

    it('moves content stored at a replaced target to another path that still uses it', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await draft.write('d/c', 'BBB');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA', 'd/c': 'BBB' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'], [sha512('BBB')]: ['v1/content/d/c'] });
    });

    it('keeps content stored at another path when its other user is replaced', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('c', 'BBB');
        await draft.write('b', 'BBB');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA', c: 'BBB' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'], [sha512('BBB')]: ['v1/content/c'] });
    });

    it('replaces a committed file, leaving earlier versions and their content unchanged', async () => {
      const object = await createObject(root, newId(), { a: 'AAA', b: 'BBB' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { a: 'AAA', b: 'BBB' });
    });

    it('replaces a file written in a later draft, storing nothing in that version', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('b', 'BBB');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v2/content')));
    });

    it('replaces a target spelled un-normalised', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'b.txt': 'b' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.copy('a.txt', './b.txt');
      });
      await assertHolds(root, updated, { 'a.txt': 'a', 'b.txt': 'a' });
    });

    it('changes nothing when the target already holds identical content, so no version is written', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'same.txt': 'a' });
      await assertWritesNothing(root, object, async () => {
        const returned = await object.update(DETAILS, async (draft) => {
          await draft.copy('a.txt', 'same.txt');
        });
        assert.strictEqual(returned, object);
      });
      await assertHolds(root, object, { 'a.txt': 'a', 'same.txt': 'a' });
    });

    it('keeps the content of a target that already holds identical content written in the same draft', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'AAA');
        await draft.copy('b', 'a');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });

    it('replaces a target removed first in the same draft, which the earlier version keeps', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'b.txt': 'b' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('b.txt');
        await draft.copy('a.txt', 'b.txt');
      });
      await assertHolds(root, updated, { 'a.txt': 'a', 'b.txt': 'a' });
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('takes the place of a directory removed first in the same draft', async () => {
      const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('d');
        await draft.copy('a', 'd');
      });
      await assertHolds(root, updated, { a: 'a', d: 'a' });
    });

    it('leaves the copy when the source is removed afterwards, moving content the draft stored to it', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.copy('a', 'b');
        await draft.remove('a');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'] });
    });

    it('keeps the content of the copy where it is when the source is then written again', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.copy('a', 'b');
        await draft.write('a', 'BBB');
      });
      const inventory = await assertHolds(root, object, { a: 'BBB', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'], [sha512('BBB')]: ['v1/content/a'] });
    });

    it('accepts a target that only shares a name prefix with existing paths', async () => {
      const object = await createObject(root, newId(), { a: 'a', bc: 'bc', 'bd/e': 'e' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.copy('a', 'b');
      });
      await assertHolds(root, updated, { a: 'a', b: 'a', bc: 'bc', 'bd/e': 'e' });
    });

    for (const [name, source, target] of [
      ['a file where a directory is', 'a.txt', 'other'],
      ['a file below a file', 'a.txt', 'b.txt/x/y.txt'],
      ['a file below a file, spelled un-normalised', 'a.txt', 'b.txt//x'],
      ['a file onto the directory it is in', 'other/d.txt', 'other'],
    ] as const) {
      it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
        await assertRefused({ 'a.txt': 'a', 'b.txt': 'b', 'other/d.txt': 'd' }, (draft) => draft.copy(source, target), 'FILE_EXISTS');
      });
    }
  });

  describe('a directory', () => {
    it('copies every file below it, mixing committed files and files written in the same draft', async () => {
      const object = await createObject(root, newId(), { 'd/old': 'OLD', 'd/deep/older': 'OLDER', keep: 'KKK' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/new', 'NEW');
        await draft.write('d/deep/newer', 'NEWER');
        await draft.copy('d', 'e/f');
      });
      const inventory = await assertHolds(root, updated, {
        'd/old': 'OLD',
        'd/deep/older': 'OLDER',
        'd/new': 'NEW',
        'd/deep/newer': 'NEWER',
        'e/f/old': 'OLD',
        'e/f/deep/older': 'OLDER',
        'e/f/new': 'NEW',
        'e/f/deep/newer': 'NEWER',
        keep: 'KKK',
      });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/d/deep/newer', 'v2/content/d/new']);
      assert.strictEqual(Object.keys(inventory.manifest).length, 5);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
    });

    it('does not copy a file whose name merely starts with the path', async () => {
      const object = await createObject(root, newId(), { 'raw/x': 'x', 'raw.txt': 'text', 'rawer/y': 'y' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.copy('raw', 'copy');
      });
      await assertHolds(root, updated, { 'raw/x': 'x', 'raw.txt': 'text', 'rawer/y': 'y', 'copy/x': 'x' });
    });

    it('takes the place of a directory removed first in the same draft', async () => {
      const object = await createObject(root, newId(), { 'dir/c': 'c', 'other/d': 'd' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('other');
        await draft.copy('dir', 'other');
      });
      await assertHolds(root, updated, { 'dir/c': 'c', 'other/c': 'c' });
    });

    for (const [name, source, target] of [
      ['a directory onto a directory that has other files', 'dir', 'other'],
      ['a directory onto a directory that has the same files', 'dir', 'twin'],
      ['a directory onto a file', 'dir', 'a.txt'],
      ['a directory below a file', 'dir', 'a.txt/sub'],
      ['a directory onto the directory it is in', 'other/sub', 'other'],
    ] as const) {
      it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
        const files = { 'a.txt': 'a', 'dir/c.txt': 'c', 'twin/c.txt': 'c', 'other/d.txt': 'd', 'other/sub/e.txt': 'e' };
        await assertRefused(files, (draft) => draft.copy(source, target), 'FILE_EXISTS');
      });
    }
  });

  describe('paths', () => {
    it('accepts an un-normalised source and target', async () => {
      const object = await createObject(root, newId(), { 'raw/1.wav': 'wav', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.copy('./raw//1.wav', './a//b');
        await draft.copy('.//d/', './e//f/');
      });
      const inventory = await assertHolds(root, updated, { 'raw/1.wav': 'wav', 'd/x': 'x', 'a/b': 'wav', 'e/f/x': 'x' });
      assert.deepStrictEqual(Object.values(inventory.versions.v2!.state).flat().sort(), ['a/b', 'd/x', 'e/f/x', 'raw/1.wav']);
    });

    const invalid = [
      ['the empty path ""', ''],
      ['the empty path "."', '.'],
      ['the empty path "./"', './'],
      ['a path that leaves the object', '../a'],
      ['a path with .. that stays in the object', 'd/../a'],
      ['a path that leaves the object with a backslash', '..\\a'],
      ['an absolute path', '/a'],
    ] as const;

    for (const [name, logicalPath] of invalid) {
      for (const [which, copy] of [
        ['source', (draft: Draft) => draft.copy(logicalPath, 'b')],
        ['target', (draft: Draft) => draft.copy('a', logicalPath)],
      ] as const) {
        it(`throws INVALID_LOGICAL_PATH for ${name} as the ${which}, copying nothing`, async () => {
          const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
          await assertWritesNothing(root, object, async () => {
            const returned = await object.update(DETAILS, async (draft) => {
              await assert.rejects(copy(draft), ocflError('INVALID_LOGICAL_PATH'));
            });
            assert.strictEqual(returned, object);
          });
          await assertHolds(root, object, { a: 'a', 'd/x': 'x' });
        });
      }
    }

    it('throws INVALID_LOGICAL_PATH for an invalid target even when the source is missing', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await object.update(DETAILS, async (draft) => {
        await assert.rejects(draft.copy('missing', ''), ocflError('INVALID_LOGICAL_PATH'));
      });
    });

    for (const [name, source, target] of [
      ['a directory into itself', 'd', 'd/sub'],
      ['a directory deep into itself', 'd', 'd/x/y/z'],
      ['a directory into itself, spelled un-normalised', './d/', 'd//sub'],
      ['a file below itself', 'a', 'a/b'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, copying nothing`, async () => {
        const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await assert.rejects(draft.copy(source, target), ocflError('INVALID_LOGICAL_PATH'));
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { a: 'a', 'd/x': 'x' });
      });
    }

    for (const [name, source, target] of [
      ['a path that is not in the draft', 'missing.txt', 'b.txt'],
      ['a path that is not in the draft, even onto an existing file', 'missing.txt', 'a'],
      ['a path that is not in the draft, even as its own target', 'missing.txt', 'missing.txt'],
      ['a path below a file', 'a/b', 'c'],
      ['a path that merely starts a file name', 'd/x', 'c'],
    ] as const) {
      it(`throws FILE_NOT_FOUND for ${name}, and the update writes nothing`, async () => {
        await assertRefused({ a: 'a', 'd/xy': 'xy' }, (draft) => draft.copy(source, target), 'FILE_NOT_FOUND');
      });
    }

    it('throws FILE_NOT_FOUND for a path removed earlier in the same draft', async () => {
      const object = await createObject(root, newId(), { a: 'a', gone: 'gone' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('gone');
        await assert.rejects(draft.copy('gone', 'b'), ocflError('FILE_NOT_FOUND'));
      });
      await assertHolds(root, updated, { a: 'a' });
    });

    it('discards the update when FILE_NOT_FOUND is left to end it', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a' });
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('c.txt', 'c');
            await draft.copy('missing.txt', 'b.txt');
          }),
          ocflError('FILE_NOT_FOUND'),
        ),
      );
      await assertHolds(root, object, { 'a.txt': 'a' });
    });

    for (const [name, source, target] of [
      ['a file', 'a.txt', 'a.txt'],
      ['a file, spelled two ways', './a.txt', 'a.txt'],
      ['a directory', 'd', 'd/'],
    ] as const) {
      it(`does nothing for the same source and target of ${name}, and a draft holding only that writes no version`, async () => {
        const object = await createObject(root, newId(), { 'a.txt': 'a', 'd/x': 'x' });
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            assert.strictEqual(await draft.copy(source, target), undefined);
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { 'a.txt': 'a', 'd/x': 'x' });
      });
    }

    it('keeps the stored content of a file written in the same draft and copied onto itself', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.copy('a', 'a');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });
  });

  describe('with imported files', () => {
    const tree = { 'metadata.json': '{}', 'data/a/a.txt': 'data a', 'data/a/aa/aa.txt': 'data aa', 'data/b/b.txt': 'data b' };
    let sourceCount = 0;

    async function newSource() {
      const source = path.join(temp.dir, `source-${sourceCount++}`);
      await writeFiles(source, tree);
      return source;
    }

    it('copies an imported file, both paths having its digest', async () => {
      const source = await newSource();
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
        await draft.copy('data/a/a.txt', 'data/c/c.txt');
      });
      await assertHolds(root, object, { ...tree, 'data/c/c.txt': 'data a' });
      assert.strictEqual(object.head.files.get('data/c/c.txt')?.digest, sha512('data a'));
      assert.strictEqual(object.head.files.get('data/a/a.txt')?.digest, sha512('data a'));
    });

    it('imports a file and a directory into a second version and copies a directory of them', async () => {
      const source = await newSource();
      const object = await createObject(root, newId(), { first: 'first' });
      const objectRoot = objectRootOf(root, object.id);
      const updated = await object.update(DETAILS, async (draft) => {
        await assert.rejects(draft.import(path.join(source, 'metadata.json'), ''), ocflError('INVALID_LOGICAL_PATH'));
        await draft.import(path.join(source, 'metadata.json'));
        await draft.import(path.join(source, 'data'));
        await draft.copy('a', 'a2');
      });
      const inventory = await assertHolds(root, updated, {
        first: 'first',
        'metadata.json': '{}',
        'a/a.txt': 'data a',
        'a/aa/aa.txt': 'data aa',
        'b/b.txt': 'data b',
        'a2/a.txt': 'data a',
        'a2/aa/aa.txt': 'data aa',
      });
      assert.strictEqual(inventory.head, 'v2');
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), [
        'v2/content/a/a.txt',
        'v2/content/a/aa/aa.txt',
        'v2/content/b/b.txt',
        'v2/content/metadata.json',
      ]);
    });
  });

  describe('the object an update returns', () => {
    it('equals the object opened afresh, after copies, writes and removals over three versions', async () => {
      const created = await createObject(root, newId(), { 'a.txt': 'a', 'dir/b.txt': 'b' });
      const second = await created.update(DETAILS, async (draft) => {
        await draft.copy('dir', 'copied');
        await draft.copy('a.txt', 'a-copy.txt');
        await draft.write('a.txt', 'changed');
      });
      const third = await second.update(DETAILS, async (draft) => {
        await draft.remove('a-copy.txt');
        await draft.copy('copied/b.txt', 'a.txt');
      });
      const opened = await root.open(created.id);
      assert.notStrictEqual(third, opened);
      assert.deepStrictEqual(await described(third), await described(opened));
      assert.deepStrictEqual(await textFiles(third.versions.get(2)!), {
        'a.txt': 'changed',
        'a-copy.txt': 'a',
        'dir/b.txt': 'b',
        'copied/b.txt': 'b',
      });
      await assertHolds(root, third, { 'a.txt': 'b', 'dir/b.txt': 'b', 'copied/b.txt': 'b' });
    });
  });

  describe('started together with other operations', () => {
    const ROUNDS = 20;
    const steps: ((draft: Draft) => Promise<void>)[] = [
      (d) => d.write('new', 'N'.repeat(100_000)),
      (d) => d.copy('new', 'copied'),
      (d) => d.remove('old'),
      (d) => d.copy('kept', 'old'),
      (d) => d.write('new-2', 'second'),
      (d) => d.copy('new-2', 'copied-2'),
      (d) => d.copy('copied', 'kept'),
    ];

    for (let round = 0; round < ROUNDS; round++) {
      it(`concurrent write, copy and remove give the same result as awaiting them in call order (round ${round})`, async () => {
        const sequential = await (await createObject(root, newId(), { old: 'old', kept: 'kept' })).update(DETAILS, async (draft) => {
          for (const step of steps) {
            await step(draft);
          }
        });
        const concurrent = await (await createObject(root, newId(), { old: 'old', kept: 'kept' })).update(DETAILS, async (draft) => {
          await Promise.all(steps.map((step) => step(draft)));
        });
        const expected = {
          new: 'N'.repeat(100_000),
          copied: 'N'.repeat(100_000),
          old: 'kept',
          kept: 'N'.repeat(100_000),
          'new-2': 'second',
          'copied-2': 'second',
        };
        await assertHolds(root, sequential, expected);
        const inventory = await assertHolds(root, concurrent, expected);
        assert.deepStrictEqual(inventory.versions.v2!.state, (await readInventory(objectRootOf(root, sequential.id))).versions.v2!.state);
        await assertVersionValid(objectRootOf(root, concurrent.id), 'v2');
      });
    }
  });

  describe('when stored content cannot be removed', () => {
    it('rejects the copy and the update, leaving no partial object', async () => {
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.write('a', 'AAA');
          await draft.write('b', 'BBB');
          await withFsFailure(
            'rm',
            (target) => target.endsWith('/content/b'),
            () => assert.rejects(draft.copy('a', 'b'), /injected failure/),
          );
        }),
        /injected failure/,
      );
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
      assert.ok(!fs.existsSync(workspaceOf(root)));
    });
  });

  describe('a draft whose update has finished', () => {
    it('throws an Error from copy after the update was committed, changing nothing', async () => {
      let kept: Draft | undefined;
      const object = await root.create(newId(), DETAILS, async (draft) => {
        kept = draft;
        await draft.write('a', 'a');
      });
      const before = await snapshot(root.path);
      await assert.rejects(kept!.copy('a', 'b'), (e) => e instanceof Error && !('code' in e));
      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertHolds(root, object, { a: 'a' });
    });

    it('throws an Error from copy after the update was discarded', async () => {
      let kept: Draft | undefined;
      const id = newId();
      const failure = new Error('stop');
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          kept = draft;
          await draft.write('a', 'a');
          throw failure;
        }),
        failure,
      );
      await assert.rejects(kept!.copy('a', 'b'), (e) => e instanceof Error && !('code' in e));
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
    });

    it('rejects an update that ends while copy is still pending, leaving the object as it was', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('a', 'changed');
            void draft.copy('a', 'b');
          }),
          /^Error: Unfinished operations detected/,
        ),
      );
      await assertHolds(root, object, { a: 'a' });
    });
  });
});
