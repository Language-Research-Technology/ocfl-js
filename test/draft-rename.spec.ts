import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Draft, StorageRoot } from '../src/index.ts';
import {
  assertHolds,
  assertRefusesWith,
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
import { moving, withFsFailure } from './helpers/fs-failures.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { writeFiles } from './helpers/storage-roots.ts';

describe('renaming in a draft', () => {
  const temp = useTempRoots('ocfl-draft-rename-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  describe('a file', () => {
    it('changes only the logical path of a committed file, storing nothing new', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'AAA', keep: 'KKK' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        assert.strictEqual(await draft.rename('a.txt', 'd/b.txt'), undefined);
      });
      const inventory = await assertHolds(root, updated, { 'd/b.txt': 'AAA', keep: 'KKK' });
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.strictEqual(updated.head.files.get('d/b.txt')?.digest, sha512('AAA'));
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { 'a.txt': 'AAA', keep: 'KKK' });
    });

    it('moves a file written in the same draft, with its manifest entry and stored content', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'] });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/b']);
    });

    it('moves a file written in a later draft without touching committed content', async () => {
      const object = await createObject(root, newId(), { a: 'AAA' });
      const v1 = await readInventory(objectRootOf(root, object.id));
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('b', 'BBB');
        await draft.rename('b', 'c');
        await draft.copy('a', 'b');
      });
      const inventory = await assertHolds(root, updated, { a: 'AAA', b: 'AAA', c: 'BBB' });
      assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
      assert.deepStrictEqual(inventory.manifest[sha512('BBB')], ['v2/content/c']);
    });

    it('moves and removes new files in the workspace before they reach the object', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.rename('a', 'x/b');
        await draft.write('c', 'CCC');
        await draft.remove('c');
        assert.deepStrictEqual(Object.keys(await snapshot(path.join(workspaceOf(root), id, 'v1/content'))), ['x/b']);
      });
      const inventory = await assertHolds(root, object, { 'x/b': 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/x/b'] });
    });

    it('replaces a file the draft wrote with another it wrote, dropping the replaced content from the manifest and the disk', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'] });
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), ['v1/content/b']);
    });

    it('leaves nothing set aside in the version when it replaces a file the draft wrote', async () => {
      const id = newId();
      await root.create(id, DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await draft.rename('a', 'b');
        assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id, 'v1')), { 'content/b': 'AAA' });
      });
    });

    it('moves content stored at a replaced target to another path that still uses it', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await draft.write('d/c', 'BBB');
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA', 'd/c': 'BBB' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'], [sha512('BBB')]: ['v1/content/d/c'] });
    });

    it('keeps content stored at another path when its other user is replaced', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('c', 'BBB');
        await draft.write('b', 'BBB');
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA', c: 'BBB' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'], [sha512('BBB')]: ['v1/content/c'] });
    });

    it('replaces a file the draft wrote with a copy whose content is stored at another path, moving no file', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.copy('a', 'c');
        await draft.write('b', 'BBB');
        await draft.rename('c', 'b');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });

    it('replaces a committed file, leaving earlier versions and their content unchanged', async () => {
      const object = await createObject(root, newId(), { a: 'AAA', b: 'BBB' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, updated, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { a: 'AAA', b: 'BBB' });
    });

    it('replaces a committed file with a file the draft wrote', async () => {
      const object = await createObject(root, newId(), { b: 'BBB' });
      const objectRoot = objectRootOf(root, object.id);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, updated, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('BBB')]: ['v1/content/b'], [sha512('AAA')]: ['v2/content/b'] });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/b']);
    });

    it('replaces a target spelled un-normalised', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'b.txt': 'b' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a.txt', './b.txt');
      });
      await assertHolds(root, updated, { 'b.txt': 'a' });
    });

    it('only unlists the source when the target already holds identical content', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'same.txt': 'a' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a.txt', 'same.txt');
      });
      const inventory = await assertHolds(root, updated, { 'same.txt': 'a' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(inventory.versions.v2!.state, { [sha512('a')]: ['same.txt'] });
    });

    for (const [name, source, target, stored] of [
      ['stored at the source', 'a', 'b', 'v1/content/b'],
      ['stored at the target', 'b', 'a', 'v1/content/a'],
    ] as const) {
      it(`keeps one stored file when the target holds identical content written in the same draft, ${name}`, async () => {
        const object = await root.create(newId(), DETAILS, async (draft) => {
          await draft.write('a', 'AAA');
          await draft.write('b', 'AAA');
          await draft.rename(source, target);
        });
        const inventory = await assertHolds(root, object, { [target]: 'AAA' });
        assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: [stored] });
      });
    }

    it('replaces a target removed first in the same draft, which the earlier version keeps', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a', 'b.txt': 'b' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('b.txt');
        await draft.rename('a.txt', 'b.txt');
      });
      await assertHolds(root, updated, { 'b.txt': 'a' });
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('takes the place of a directory removed first in the same draft', async () => {
      const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('d');
        await draft.rename('a', 'd');
      });
      await assertHolds(root, updated, { d: 'a' });
    });

    it('accepts a target that only shares a name prefix with existing paths', async () => {
      const object = await createObject(root, newId(), { a: 'a', bc: 'bc', 'bd/e': 'e' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a', 'b');
      });
      await assertHolds(root, updated, { b: 'a', bc: 'bc', 'bd/e': 'e' });
    });

    for (const [name, source, target] of [
      ['a file where a directory is', 'a.txt', 'other'],
      ['a file below a file', 'a.txt', 'b.txt/x/y.txt'],
      ['a file below a file, spelled un-normalised', 'a.txt', 'b.txt//x'],
      ['a file onto the directory it is in', 'other/d.txt', 'other'],
    ] as const) {
      it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
        await assertRefusesWith(root, newId(), { 'a.txt': 'a', 'b.txt': 'b', 'other/d.txt': 'd' }, (draft) => draft.rename(source, target), 'FILE_EXISTS');
      });
    }
  });

  describe('a directory', () => {
    it('moves every file below it, mixing committed files and files written in the same draft', async () => {
      const object = await createObject(root, newId(), { 'd/old': 'OLD', 'd/deep/older': 'OLDER', keep: 'KKK' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/new', 'NEW');
        await draft.write('d/deep/newer', 'NEWER');
        await draft.rename('d', 'e/f');
      });
      const inventory = await assertHolds(root, updated, {
        'e/f/old': 'OLD',
        'e/f/deep/older': 'OLDER',
        'e/f/new': 'NEW',
        'e/f/deep/newer': 'NEWER',
        keep: 'KKK',
      });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/e/f/deep/newer', 'v2/content/e/f/new']);
      assert.deepStrictEqual(inventory.manifest[sha512('OLD')], v1.manifest[sha512('OLD')]);
      assert.deepStrictEqual(inventory.manifest[sha512('OLDER')], v1.manifest[sha512('OLDER')]);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { 'd/old': 'OLD', 'd/deep/older': 'OLDER', keep: 'KKK' });
    });

    it('does not move a file whose name merely starts with the path', async () => {
      const object = await createObject(root, newId(), { 'raw/x': 'x', 'raw.txt': 'text', 'rawer/y': 'y' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('raw', 'moved');
      });
      await assertHolds(root, updated, { 'moved/x': 'x', 'raw.txt': 'text', 'rawer/y': 'y' });
    });

    it('takes the place of a directory removed first in the same draft', async () => {
      const object = await createObject(root, newId(), { 'dir/c': 'c', 'other/d': 'd' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('other');
        await draft.rename('dir', 'other');
      });
      await assertHolds(root, updated, { 'other/c': 'c' });
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
        await assertRefusesWith(root, newId(), files, (draft) => draft.rename(source, target), 'FILE_EXISTS');
      });
    }
  });

  describe('with other operations in one draft', () => {
    type Step = (draft: Draft) => Promise<void>;
    const scenarios: [string, Step[], Record<string, string>, string[]][] = [
      ['rename a directory', [(d) => d.write('d/x', 'XXX'), (d) => d.rename('d', 'e')], { 'e/x': 'XXX' }, ['v1/content/e/x']],
      ['rename to a target in a new directory', [(d) => d.write('a', 'AAA'), (d) => d.rename('a', 'x/y/b')], { 'x/y/b': 'AAA' }, ['v1/content/x/y/b']],
      [
        'rename a file that has a copy',
        [(d) => d.write('a', 'AAA'), (d) => d.copy('a', 'b'), (d) => d.rename('a', 'c')],
        { b: 'AAA', c: 'AAA' },
        ['v1/content/c'],
      ],
      [
        'rename a copy whose content is stored at another path',
        [(d) => d.write('a', 'AAA'), (d) => d.copy('a', 'b'), (d) => d.rename('b', 'c')],
        { a: 'AAA', c: 'AAA' },
        ['v1/content/a'],
      ],
      [
        'rename a directory holding two paths with the same content',
        [(d) => d.write('d/x', 'AAA'), (d) => d.write('d/y', 'AAA'), (d) => d.rename('d', 'e')],
        { 'e/x': 'AAA', 'e/y': 'AAA' },
        ['v1/content/e/x'],
      ],
      [
        'rename a file, then write new content to the old name',
        [(d) => d.write('a', 'AAA'), (d) => d.rename('a', 'b'), (d) => d.write('a', 'ZZZ')],
        { a: 'ZZZ', b: 'AAA' },
        ['v1/content/a', 'v1/content/b'],
      ],
      [
        'rename a file, then write the same content to the old name',
        [(d) => d.write('a', 'AAA'), (d) => d.rename('a', 'b'), (d) => d.write('a', 'AAA')],
        { a: 'AAA', b: 'AAA' },
        ['v1/content/b'],
      ],
      ['rename a file and back again', [(d) => d.write('a', 'AAA'), (d) => d.rename('a', 'b'), (d) => d.rename('b', 'a')], { a: 'AAA' }, ['v1/content/a']],
      [
        'remove a file, then rename another onto its name',
        [(d) => d.write('a', 'AAA'), (d) => d.write('b', 'BBB'), (d) => d.remove('b'), (d) => d.rename('a', 'b')],
        { b: 'AAA' },
        ['v1/content/b'],
      ],
      [
        'swap two files through a third name',
        [(d) => d.write('a', 'AAA'), (d) => d.write('b', 'BBB'), (d) => d.rename('a', 't'), (d) => d.rename('b', 'a'), (d) => d.rename('t', 'b')],
        { a: 'BBB', b: 'AAA' },
        ['v1/content/a', 'v1/content/b'],
      ],
      [
        'rename onto a file, then write the old name again',
        [(d) => d.write('a', 'AAA'), (d) => d.write('b', 'BBB'), (d) => d.rename('a', 'b'), (d) => d.write('a', 'BBB')],
        { a: 'BBB', b: 'AAA' },
        ['v1/content/a', 'v1/content/b'],
      ],
    ];

    for (const [name, steps, expected, files] of scenarios) {
      it(`${name}: commits, stays valid and reads back`, async () => {
        const object = await root.create(newId(), DETAILS, async (draft) => {
          for (const step of steps) {
            await step(draft);
          }
        });
        const inventory = await assertHolds(root, object, expected);
        assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v1'), files);
        assert.deepStrictEqual(Object.values(inventory.manifest).flat().sort(), files);
      });
    }

    it('gives the same result started together as awaited in call order', async () => {
      const steps: Step[] = [
        (d) => d.write('new', 'N'.repeat(100_000)),
        (d) => d.rename('new', 'moved'),
        (d) => d.rename('old', 'older'),
        (d) => d.write('old', 'again'),
        (d) => d.rename('moved', 'kept'),
      ];
      const sequential = await (await createObject(root, newId(), { old: 'old', kept: 'kept' })).update(DETAILS, async (draft) => {
        for (const step of steps) {
          await step(draft);
        }
      });
      const concurrent = await (await createObject(root, newId(), { old: 'old', kept: 'kept' })).update(DETAILS, async (draft) => {
        await Promise.all(steps.map((step) => step(draft)));
      });
      const expected = { older: 'old', old: 'again', kept: 'N'.repeat(100_000) };
      await assertHolds(root, sequential, expected);
      const inventory = await assertHolds(root, concurrent, expected);
      assert.deepStrictEqual(inventory.versions.v2!.state, (await readInventory(objectRootOf(root, sequential.id))).versions.v2!.state);
    });
  });

  describe('paths', () => {
    it('accepts an un-normalised source and target', async () => {
      const object = await createObject(root, newId(), { 'raw/1.wav': 'wav', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('./raw//1.wav', './a//b');
        await draft.rename('.//d/', './e//f/');
      });
      const inventory = await assertHolds(root, updated, { 'a/b': 'wav', 'e/f/x': 'x' });
      assert.deepStrictEqual(Object.values(inventory.versions.v2!.state).flat().sort(), ['a/b', 'e/f/x']);
    });

    it('stores the content of a file the draft wrote at the normalised target', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.rename('./a', './x//b');
      });
      const inventory = await assertHolds(root, object, { 'x/b': 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/x/b'] });
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
      for (const [which, rename] of [
        ['source', (draft: Draft) => draft.rename(logicalPath, 'b')],
        ['target', (draft: Draft) => draft.rename('a', logicalPath)],
      ] as const) {
        it(`throws INVALID_LOGICAL_PATH for ${name} as the ${which}, moving nothing`, async () => {
          await assertRefusesWith(root, newId(), { a: 'a', 'd/x': 'x' }, rename, 'INVALID_LOGICAL_PATH');
        });
      }
    }

    it('throws INVALID_LOGICAL_PATH for an invalid target even when the source is missing', async () => {
      await assertRefusesWith(root, newId(), { a: 'a' }, (draft) => draft.rename('missing', ''), 'INVALID_LOGICAL_PATH');
    });

    for (const [name, source, target] of [
      ['a directory into itself', 'd', 'd/sub'],
      ['a directory deep into itself', 'd', 'd/x/y/z'],
      ['a directory into itself, spelled un-normalised', './d/', 'd//sub'],
      ['a file below itself', 'a', 'a/b'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, moving nothing`, async () => {
        await assertRefusesWith(root, newId(), { a: 'a', 'd/x': 'x' }, (draft) => draft.rename(source, target), 'INVALID_LOGICAL_PATH');
      });
    }

    it('keeps a directory the draft wrote where it is when it is renamed into itself', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('d/x', 'XXX');
        await assert.rejects(draft.rename('d', 'd/sub'), ocflError('INVALID_LOGICAL_PATH'));
      });
      const inventory = await assertHolds(root, object, { 'd/x': 'XXX' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('XXX')]: ['v1/content/d/x'] });
    });

    for (const [name, source, target] of [
      ['a path that is not in the draft', 'missing.txt', 'b.txt'],
      ['a path that is not in the draft, even onto an existing file', 'missing.txt', 'a'],
      ['a path that is not in the draft, even as its own target', 'missing.txt', 'missing.txt'],
      ['a path below a file', 'a/b', 'c'],
      ['a path that merely starts a file name', 'd/x', 'c'],
    ] as const) {
      it(`throws FILE_NOT_FOUND for ${name}, and the update writes nothing`, async () => {
        await assertRefusesWith(root, newId(), { a: 'a', 'd/xy': 'xy' }, (draft) => draft.rename(source, target), 'FILE_NOT_FOUND');
      });
    }

    it('throws FILE_NOT_FOUND for a missing source without moving anything the draft stored', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        const stored = await snapshot(path.join(workspaceOf(root), id));
        await assert.rejects(draft.rename('missing', 'b'), ocflError('FILE_NOT_FOUND'));
        assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
      });
      await assertHolds(root, object, { a: 'AAA' });
    });

    it('throws FILE_NOT_FOUND for a path renamed away earlier in the same draft', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('a', 'b');
        await assert.rejects(draft.rename('a', 'c'), ocflError('FILE_NOT_FOUND'));
      });
      await assertHolds(root, updated, { b: 'a' });
    });

    it('discards the update when FILE_NOT_FOUND is left to end it', async () => {
      const object = await createObject(root, newId(), { 'a.txt': 'a' });
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('c.txt', 'c');
            await draft.rename('missing.txt', 'b.txt');
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
            assert.strictEqual(await draft.rename(source, target), undefined);
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { 'a.txt': 'a', 'd/x': 'x' });
      });
    }

    it('keeps the stored content of a file written in the same draft and renamed onto itself', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.rename('a', 'a');
      });
      const inventory = await assertHolds(root, object, { a: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });

    it('writes no version when a file is renamed and back again', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await assertWritesNothing(root, object, async () => {
        const returned = await object.update(DETAILS, async (draft) => {
          await draft.rename('a', 'b');
          await draft.rename('b', 'a');
        });
        assert.strictEqual(returned, object);
      });
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

    it('renames an imported file, the target having its digest and the source gone', async () => {
      const source = await newSource();
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
        await draft.rename('data/a/a.txt', 'data/c/c.txt');
      });
      await assertHolds(root, object, {
        'metadata.json': '{}',
        'data/c/c.txt': 'data a',
        'data/a/aa/aa.txt': 'data aa',
        'data/b/b.txt': 'data b',
      });
      assert.strictEqual(object.head.files.get('data/c/c.txt')?.digest, sha512('data a'));
      assert.strictEqual(object.head.files.get('data/a/a.txt'), undefined);
    });

    it('renames imported files and directories over two versions', async () => {
      const source = await newSource();
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.import(source);
        await draft.write('empty2.txt', '');
        await draft.write('foo2/bar.txt', 'bar');
      });
      const objectRoot = objectRootOf(root, object.id);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.rename('empty2.txt', 'empty.txt');
        await draft.rename('foo2', 'bar');
        await draft.rename('data', 'moved/data');
      });
      const inventory = await assertHolds(root, updated, {
        'metadata.json': '{}',
        'empty.txt': '',
        'bar/bar.txt': 'bar',
        'moved/data/a/a.txt': 'data a',
        'moved/data/a/aa/aa.txt': 'data aa',
        'moved/data/b/b.txt': 'data b',
      });
      assert.strictEqual(inventory.head, 'v2');
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.strictEqual(updated.head.files.get('empty2.txt'), undefined);
      assert.strictEqual(updated.head.files.get('foo2/bar.txt'), undefined);
    });
  });

  describe('when stored content cannot be moved', () => {
    it('puts files back and keeps the source when renaming a directory fails part-way', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.write('d/x', 'XXX');
        await draft.write('d/y', 'YYY');
        const stored = await snapshot(path.join(workspaceOf(root), id));
        await withFsFailure('rename', moving('/content/d/y', '/content/e/y'), () => assert.rejects(draft.rename('d', 'e'), /injected failure/));
        assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
        assert.ok(!fs.existsSync(path.join(workspaceOf(root), id, 'v1/content/e')));
      });
      const inventory = await assertHolds(root, object, { 'd/x': 'XXX', 'd/y': 'YYY' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('XXX')]: ['v1/content/d/x'], [sha512('YYY')]: ['v1/content/d/y'] });
    });

    it('puts the replaced file back and keeps the source when the move onto it fails', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        const stored = await snapshot(path.join(workspaceOf(root), id));
        await withFsFailure('rename', moving('/content/a', '/content/b'), () => assert.rejects(draft.rename('a', 'b'), /injected failure/));
        assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
      });
      const inventory = await assertHolds(root, object, { a: 'AAA', b: 'BBB' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'], [sha512('BBB')]: ['v1/content/b'] });
    });

    it('keeps everything in place when the replaced file cannot be set aside', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await withFsFailure(
          'rename',
          (source) => source.endsWith('/content/b'),
          () => assert.rejects(draft.rename('a', 'b'), /injected failure/),
        );
      });
      await assertHolds(root, object, { a: 'AAA', b: 'BBB' });
    });

    it('can rename again after a failed rename', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('b', 'BBB');
        await withFsFailure('rename', moving('/content/a', '/content/b'), () => assert.rejects(draft.rename('a', 'b'), /injected failure/));
        await draft.rename('a', 'b');
      });
      const inventory = await assertHolds(root, object, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'] });
    });

    it('leaves no directory behind for a target the content could not be moved to', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a/a', 'XXX');
        await withFsFailure('rename', moving('/content/a/a', '/content/b/a'), () => assert.rejects(draft.rename('a/a', 'b/a'), /injected failure/));
      });
      const inventory = await assertHolds(root, object, { 'a/a': 'XXX' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('XXX')]: ['v1/content/a/a'] });
    });

    it('can write a file where a failed rename would have made a directory', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('b', 'XXX');
        await withFsFailure('rename', moving('/content/b', '/content/a/a'), () => assert.rejects(draft.rename('b', 'a/a'), /injected failure/));
        await draft.write('a', 'ZZZ');
      });
      await assertHolds(root, object, { a: 'ZZZ', b: 'XXX' });
    });

    for (const [name, files, fails] of [
      [
        'a move',
        { 'd/x': 'XXX', 'd/y': 'YYY' },
        (source: string, target: string) => moving('/content/d/y', '/content/e/y')(source, target) || source.endsWith('/content/e/x'),
      ],
      [
        'a replaced file set aside',
        { d: 'XXX', e: 'YYY' },
        (source: string, target: string) => moving('/content/d', '/content/e')(source, target) || target.endsWith('/content/e'),
      ],
    ] as const) {
      it(`reports the original failure and does not commit when ${name} cannot be undone`, async () => {
        const id = newId();
        let failure: unknown;
        await assert.rejects(
          root.create(id, DETAILS, async (draft) => {
            for (const [logicalPath, content] of Object.entries(files)) {
              await draft.write(logicalPath, content);
            }
            await withFsFailure('rename', fails, async () => {
              failure = await draft.rename('d', 'e').catch((error: unknown) => error);
            });
            assert.match(String(failure), /injected failure/);
          }),
          (error) => error === failure,
        );
        assert.ok(!fs.existsSync(objectRootOf(root, id)));
        assert.ok(!fs.existsSync(workspaceOf(root)));
      });
    }

    it('rejects the rename and the update when the replaced content cannot be removed, leaving no partial object', async () => {
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.write('a', 'AAA');
          await draft.write('b', 'BBB');
          await withFsFailure(
            'rm',
            (target) => path.basename(target).startsWith('.staged-'),
            () => assert.rejects(draft.rename('a', 'b'), /injected failure/),
          );
        }),
        /injected failure/,
      );
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
      assert.ok(!fs.existsSync(workspaceOf(root)));
    });
  });

  describe('a draft whose update has finished', () => {
    it('throws an Error from rename after the update was committed, changing nothing', async () => {
      let kept: Draft | undefined;
      const object = await root.create(newId(), DETAILS, async (draft) => {
        kept = draft;
        await draft.write('a', 'a');
      });
      const before = await snapshot(root.path);
      await assert.rejects(kept!.rename('a', 'b'), (e) => e instanceof Error && !('code' in e));
      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertHolds(root, object, { a: 'a' });
    });

    it('throws an Error from rename after the update was discarded', async () => {
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
      await assert.rejects(kept!.rename('a', 'b'), (e) => e instanceof Error && !('code' in e));
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
    });

    it('rejects an update that ends while rename is still pending, leaving the object as it was', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('a', 'changed');
            void draft.rename('a', 'b');
          }),
          /^Error: Unfinished operations detected/,
        ),
      );
      await assertHolds(root, object, { a: 'a' });
    });
  });
});
