import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Draft, StorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import {
  assertHolds,
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
import { ocflError } from './ocfl-error.ts';

describe('removing from a draft', () => {
  const temp = useTempRoots('ocfl-draft-remove-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  describe('remove', () => {
    it('removes a file and a directory of the head version, which earlier versions keep', async () => {
      const files = { 'test.txt': 'test', 'bar/bar.xml': '<bar/>', 'bar/deep/baz.xml': '<baz/>', 'keep.txt': 'keep' };
      const object = await createObject(root, newId(), files);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('test.txt');
        await draft.remove('bar');
      });
      const inventory = await assertHolds(root, updated, { 'keep.txt': 'keep' });
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), files);
      assert.deepStrictEqual(await textFiles(object.head), files);
      assert.deepStrictEqual(await storedFiles(objectRootOf(root, object.id), 'v2'), []);
      assert.strictEqual(Object.keys(inventory.manifest).length, 4);
    });

    it('removes the stored file and manifest entry of content nothing else uses', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.write('keep', 'KKK');
        await draft.remove('a');
      });
      const inventory = await assertHolds(root, object, { keep: 'KKK' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('KKK')]: ['v1/content/keep'] });
    });

    it('leaves no manifest entry or content directory when the only file is removed', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await draft.remove('a');
      });
      const inventory = await assertHolds(root, object, {});
      assert.deepStrictEqual(inventory.manifest, {});
      assert.ok(!fs.existsSync(path.join(objectRootOf(root, object.id), 'v1/content')));
    });

    type Step = (draft: Draft) => Promise<void>;
    const scenarios: [string, Step[], Record<string, string>, string[]][] = [
      [
        'the file storing content another path shares',
        [(d) => d.write('a', 'AAA'), (d) => d.write('b', 'AAA'), (d) => d.remove('a')],
        { b: 'AAA' },
        ['v1/content/b'],
      ],
      [
        'a path whose content is stored at another path',
        [(d) => d.write('a', 'AAA'), (d) => d.write('b', 'AAA'), (d) => d.remove('b')],
        { a: 'AAA' },
        ['v1/content/a'],
      ],
      [
        'a file, then writing identical content',
        [(d) => d.write('a', 'AAA'), (d) => d.remove('a'), (d) => d.write('a', 'AAA')],
        { a: 'AAA' },
        ['v1/content/a'],
      ],
      ['a directory', [(d) => d.write('d/x', 'XXX'), (d) => d.write('d/y/z', 'ZZZ'), (d) => d.remove('d')], {}, []],
      [
        'a directory whose content is also used outside it',
        [(d) => d.write('d/x', 'AAA'), (d) => d.write('d/y', 'AAA'), (d) => d.write('z', 'AAA'), (d) => d.remove('d')],
        { z: 'AAA' },
        ['v1/content/z'],
      ],
      [
        'a directory, then writing a file in its place',
        [(d) => d.write('d/x', 'XXX'), (d) => d.remove('d'), (d) => d.write('d', 'file')],
        { d: 'file' },
        ['v1/content/d'],
      ],
    ];

    for (const [name, steps, expected, files] of scenarios) {
      it(`removing ${name} commits, stays valid and reads back`, async () => {
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

    it('keeps the stored content of a committed file for the other path that shares it', async () => {
      const object = await createObject(root, newId(), { a: 'AAA', b: 'AAA' });
      const v1 = await readInventory(objectRootOf(root, object.id));
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('a');
      });
      const inventory = await assertHolds(root, updated, { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
    });

    it('removes a directory mixing committed and new files, leaving earlier versions unchanged', async () => {
      const object = await createObject(root, newId(), { 'd/old': 'OLD', keep: 'KKK' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('d/new', 'NEW');
        await draft.remove('d');
      });
      const inventory = await assertHolds(root, updated, { keep: 'KKK' });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
    });

    it('lets write replace a directory of the head version removed first in the same draft', async () => {
      const object = await createObject(root, newId(), { 'd/x': 'x', a: 'a' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('d');
        await draft.write('d', 'file');
      });
      await assertHolds(root, updated, { a: 'a', d: 'file' });
    });

    it('removes a path given un-normalised', async () => {
      const object = await createObject(root, newId(), { 'raw/1.wav': 'wav', 'raw/2.wav': 'wav2', 'd/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('./raw//1.wav');
        await draft.remove('.//d/');
      });
      await assertHolds(root, updated, { 'raw/2.wav': 'wav2' });
    });

    it('does not remove a file whose name merely starts with the path', async () => {
      const object = await createObject(root, newId(), { raw: 'file', 'raw.txt': 'text', 'rawer/x': 'x' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.remove('raw');
      });
      await assertHolds(root, updated, { 'raw.txt': 'text', 'rawer/x': 'x' });
    });

    for (const [name, logicalPath] of [
      ['a path that is not in the draft', 'missing.txt'],
      ['a path below a file', 'a/b'],
      ['a path removed earlier in the same draft', 'gone'],
    ] as const) {
      it(`throws FILE_NOT_FOUND for ${name}, and the update writes nothing`, async () => {
        const object = await createObject(root, newId(), { a: 'a' });
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await draft.write('gone', 'gone');
            await draft.remove('gone');
            await assert.rejects(draft.remove(logicalPath), ocflError('FILE_NOT_FOUND'));
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { a: 'a' });
      });
    }

    it('discards the update when FILE_NOT_FOUND is left to end it', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      await assertWritesNothing(root, object, () =>
        assert.rejects(
          object.update(DETAILS, async (draft) => {
            await draft.write('b', 'b');
            await draft.remove('missing.txt');
          }),
          ocflError('FILE_NOT_FOUND'),
        ),
      );
      await assertHolds(root, object, { a: 'a' });
    });

    for (const [name, logicalPath] of [
      ['the empty path ""', ''],
      ['the empty path "."', '.'],
      ['the empty path "./"', './'],
      ['a path that leaves the object', '../a'],
      ['a path with .. that stays in the object', 'd/../a'],
      ['a path that leaves the object with a backslash', '..\\a'],
      ['an absolute path', '/a'],
    ] as const) {
      it(`throws INVALID_LOGICAL_PATH for ${name}, removing nothing`, async () => {
        const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x' });
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await assert.rejects(draft.remove(logicalPath), ocflError('INVALID_LOGICAL_PATH'));
          });
          assert.strictEqual(returned, object);
        });
        await assertHolds(root, object, { a: 'a', 'd/x': 'x' });
      });
    }

    it('rejects the update and leaves no partial object when removing stored content fails', async () => {
      const id = newId();
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await draft.write('d/x', 'XXX');
          await draft.write('d/y', 'YYY');
          await withFsFailure(
            'rm',
            (target) => target.endsWith('/content/d/y'),
            () => assert.rejects(draft.remove('d'), /injected failure/),
          );
        }),
      );
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
      assert.ok(!fs.existsSync(workspaceOf(root)));
      await assert.rejects(root.open(id), ocflError('OBJECT_NOT_FOUND'));
    });
  });

  describe('clear', () => {
    it('removes every file of the head version, which earlier versions keep', async () => {
      const files = { a: 'a', 'd/x': 'x', 'd/deep/y': 'y' };
      const object = await createObject(root, newId(), files);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.clear();
      });
      const inventory = await assertHolds(root, updated, {});
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(inventory.versions.v2!.state, {});
      assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), files);
      assert.strictEqual(Object.keys(inventory.manifest).length, 3);
    });

    it('removes files written earlier in the same draft, with their stored content', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      const objectRoot = objectRootOf(root, object.id);
      const v1 = await readInventory(objectRoot);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('b', 'b');
        await draft.write('d/c', 'c');
        await draft.clear();
      });
      const inventory = await assertHolds(root, updated, {});
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
    });

    it('does nothing on an empty draft, and can be called twice', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.clear();
        await draft.write('a', 'a');
        await draft.clear();
        await draft.clear();
      });
      const inventory = await assertHolds(root, object, {});
      assert.deepStrictEqual(inventory.manifest, {});
    });

    it('commits a first version with no files', async () => {
      const id = newId();
      const object = await root.create(id, DETAILS, async (draft) => {
        await draft.clear();
      });
      const inventory = await assertHolds(root, object, {});
      assert.strictEqual(inventory.head, 'v1');
      assert.deepStrictEqual(inventory.versions.v1!.state, {});
      assert.ok(!fs.existsSync(path.join(objectRootOf(root, id), 'v1/content')));
    });

    it('followed by writes commits a version holding only the new files', async () => {
      const object = await createObject(root, newId(), { a: 'a', 'd/x': 'x', same: 'same' });
      const objectRoot = objectRootOf(root, object.id);
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.clear();
        await draft.write('new', 'new');
        await draft.write('d', 'now a file');
        await draft.write('same', 'same');
      });
      await assertHolds(root, updated, { new: 'new', d: 'now a file', same: 'same' });
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/d', 'v2/content/new']);
    });

    it('takes effect in call order when started together with writes', async () => {
      const object = await createObject(root, newId(), { a: 'a' });
      const updated = await object.update(DETAILS, async (draft) => {
        await Promise.all([draft.write('before', 'before'), draft.clear(), draft.write('after', 'after')]);
      });
      await assertHolds(root, updated, { after: 'after' });
    });
  });

  describe('a draft that ends where it started', () => {
    for (const [name, change] of [
      ['writing and removing a file', (d) => d.write('b', 'BBB').then(() => d.remove('b'))],
      ['removing a file and writing it again', (d) => d.remove('a').then(() => d.write('a', 'AAA'))],
      ['removing a directory and writing its files again', (d) => d.remove('d').then(() => d.write('d/x', 'XXX'))],
      ['clearing and writing every file again', (d) => d.clear().then(() => Promise.all([d.write('a', 'AAA'), d.write('d/x', 'XXX')]).then(() => {}))],
    ] as [string, (draft: Draft) => Promise<void>][]) {
      it(`writes no version after ${name}`, async () => {
        const object = await createObject(root, newId(), { a: 'AAA', 'd/x': 'XXX' });
        await assertWritesNothing(root, object, async () => {
          assert.strictEqual(await object.update(DETAILS, change), object);
        });
        assert.strictEqual((await readInventory(objectRootOf(root, object.id))).head, 'v1');
        await assertHolds(root, object, { a: 'AAA', 'd/x': 'XXX' });
      });
    }
  });

  describe('a draft whose update has finished', () => {
    const operations: [string, (draft: Draft) => Promise<void>][] = [
      ['remove', (draft) => draft.remove('a')],
      ['clear', (draft) => draft.clear()],
    ];

    for (const [name, operation] of operations) {
      it(`throws an Error from ${name} after the update was committed, changing nothing`, async () => {
        let kept: Draft | undefined;
        const object = await root.create(newId(), DETAILS, async (draft) => {
          kept = draft;
          await draft.write('a', 'a');
        });
        const before = await snapshot(root.path);
        await assert.rejects(operation(kept!), (e) => e instanceof Error && !('code' in e));
        assert.deepStrictEqual(await snapshot(root.path), before);
        await assertHolds(root, object, { a: 'a' });
      });

      it(`throws an Error from ${name} after the update was discarded`, async () => {
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
        await assert.rejects(operation(kept!), (e) => e instanceof Error && !('code' in e));
        assert.ok(!fs.existsSync(objectRootOf(root, id)));
      });

      it(`rejects an update that ends while ${name} is still pending, leaving the object as it was`, async () => {
        const object = await createObject(root, newId(), { a: 'a' });
        await assertWritesNothing(root, object, () =>
          assert.rejects(
            object.update(DETAILS, async (draft) => {
              await draft.write('a', 'changed');
              void operation(draft);
            }),
            /^Error: Unfinished operations detected/,
          ),
        );
        await assertHolds(root, object, { a: 'a' });
      });
    }
  });
});
