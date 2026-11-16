import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { ListedObject, OcflError, OcflObject, StorageRoot } from '../src/index.ts';
import { openStorageRoot } from '../src/index.ts';
import { createObject, DETAILS, objectRootOf, placesOf, textFiles, useTempRoots, writeB } from './helpers/drafts.ts';
import { stillOpen, trackOpendir, withFsFailure } from './helpers/fs-failures.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import { rewriteInventory, STORAGE_FIXTURE, writeFiles } from './helpers/storage-roots.ts';

type Damaged = Extract<ListedObject, { error: OcflError }>;

/** Everything `root.objects()` yields, objects and damaged object roots apart */
async function listed(root: StorageRoot) {
  const objects: OcflObject[] = [];
  const damaged: Damaged[] = [];
  for await (const entry of root.objects()) {
    if ('error' in entry) {
      damaged.push(entry);
    } else {
      objects.push(entry.object);
    }
  }
  return { objects, damaged: damaged.map(brief), ids: objects.map((o) => o.id).sort() };
}

/** A damaged object root's fields, comparable as a whole; `id` is left out when the entry has none */
function brief({ error, objectRoot, ...rest }: Damaged) {
  return { code: error.code, ocflCode: error.ocflCode, objectRoot, ...rest };
}

describe('root.objects', () => {
  const { newRoot } = useTempRoots('ocfl-list-objects-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** A storage root with the 0004 layout holding the objects `a`, `b` and `c`, each with `a.txt` holding its id */
  async function threeObjects() {
    const root = await newRoot({ extensionName: HASHED });
    for (const id of ['a', 'b', 'c']) {
      await createObject(root, id, { 'a.txt': id });
    }
    return root;
  }

  it('yields every object in the storage root, opened and ready to read', async () => {
    const root = await threeObjects();

    const { objects, damaged, ids } = await listed(root);

    assert.deepStrictEqual(damaged, []);
    assert.deepStrictEqual(ids, ['a', 'b', 'c']);
    for (const object of objects) {
      assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': object.id });
    }
  });

  it('lists the object of a storage root written by another tool', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);

    const { ids, damaged } = await listed(root);

    assert.deepStrictEqual(damaged, []);
    assert.deepStrictEqual(ids, ['http://example.org/minimal_no_content']);
  });

  it('yields nothing for a storage root with no objects', async () => {
    assert.deepStrictEqual(await listed(await newRoot()), { objects: [], damaged: [], ids: [] });
  });

  it('yields objects that can be updated', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    const {
      objects: [object],
    } = await listed(root);

    const updated = await object!.update(DETAILS, writeB);

    assert.deepStrictEqual(await textFiles((await root.open('a')).head), { 'a.txt': 'a', 'b.txt': 'b' });
    assert.strictEqual(updated.head.number, 2);
  });

  it('yields each object as it is when the listing reaches it', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    const listing = root.objects()[Symbol.asyncIterator]();
    await (await root.open('a')).update(DETAILS, writeB);

    const { value } = await listing.next();
    await listing.return?.();

    assert.ok(value && 'object' in value);
    assert.strictEqual(value.object.head.number, 2);
  });

  describe('a damaged object root', () => {
    it('is yielded with its INVALID_OBJECT error and where it is in the storage root, and the listing carries on', async () => {
      const root = await newRoot();
      for (const id of ['a', 'corrupt', 'z']) {
        await createObject(root, id, { 'a.txt': id });
      }
      await fs.promises.writeFile(path.join(objectRootOf(root, 'corrupt'), 'inventory.json'), '{ not json');

      const { ids, damaged } = await listed(root);

      assert.deepStrictEqual(ids, ['a', 'z']);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E033', objectRoot: 'corrupt' }]);
    });

    it('is named from the storage root with / between directories, however deep it is', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      await createObject(root, 'deep/nested/corrupt', { 'a.txt': 'a' });
      await fs.promises.writeFile(path.join(root.path, 'deep', 'nested', 'corrupt', '__object__', 'inventory.json'), '{ not json');

      const { damaged } = await listed(root);

      assert.deepStrictEqual(
        damaged.map((d) => d.objectRoot),
        ['deep/nested/corrupt/__object__'],
      );
    });

    it('is named by the object root the hashed layout gave it', async () => {
      const root = await newRoot({ extensionName: HASHED });
      await createObject(root, 'a', { 'a.txt': 'a' });
      // sha256('a'), split into three 3-character tuples
      const objectRoot = 'ca9/781/12c/ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
      await fs.promises.writeFile(path.join(root.path, objectRoot, 'inventory.json'), '{ not json');

      const { damaged } = await listed(root);

      assert.deepStrictEqual(
        damaged.map((d) => d.objectRoot),
        [objectRoot],
      );
    });

    it('is yielded with the OCFL code of what is wrong with its inventory, and the id the inventory names', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      await rewriteInventory(objectRootOf(root, 'a'), (inventory) => {
        inventory.head = 'v9';
      });

      const { objects, damaged } = await listed(root);

      assert.deepStrictEqual(objects, []);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E040', objectRoot: 'a', id: 'a' }]);
    });

    it('is yielded with the id its inventory names when the inventory does not match its sidecar', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      const inventory = path.join(objectRootOf(root, 'a'), 'inventory.json');
      await fs.promises.writeFile(inventory, `${await fs.promises.readFile(inventory, 'utf8')}\n`);

      const { damaged } = await listed(root);

      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E060', objectRoot: 'a', id: 'a' }]);
    });

    it('is yielded with no id when its inventory names none', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      await rewriteInventory(objectRootOf(root, 'a'), (inventory) => {
        delete inventory.id;
      });

      const { damaged } = await listed(root);

      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E036', objectRoot: 'a' }]);
    });

    it('is reported, not searched for objects, when its object declaration is invalid', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      await createObject(root, 'good', { 'a.txt': 'a' });
      const damagedDir = path.join(root.path, 'damaged');
      await fs.promises.cp(path.join(root.path, 'good', '__object__'), path.join(damagedDir, 'inner'), { recursive: true });
      await writeFiles(damagedDir, { '0=ocfl_object_1.1': 'wrong\n' });

      const { ids, damaged } = await listed(root);

      assert.deepStrictEqual(ids, ['good']);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E007', objectRoot: 'damaged' }]);
    });

    it('is reported with E081, and the id its inventory names, when its OCFL version is later than the storage root', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      await fs.promises.rm(path.join(root.path, '0=ocfl_1.1'));
      await writeFiles(root.path, { '0=ocfl_1.0': 'ocfl_1.0\n' });

      const { objects, damaged } = await listed(await openStorageRoot(root.path));

      assert.deepStrictEqual(objects, []);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E081', objectRoot: 'a', id: 'a' }]);
    });

    it('is reported with no id when it has an object declaration and no inventory', async () => {
      const root = await newRoot();
      await writeFiles(objectRootOf(root, 'no-inventory'), { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });

      const { objects, damaged } = await listed(root);

      assert.deepStrictEqual(objects, []);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E063', objectRoot: 'no-inventory' }]);
    });

    it('is yielded with no id, and the listing carries on, when its inventory cannot be read for the id', async () => {
      const root = await newRoot();
      await createObject(root, 'good', { 'a.txt': 'a' });
      await fs.promises.mkdir(path.join(objectRootOf(root, 'damaged'), 'inventory.json'), { recursive: true });
      await writeFiles(objectRootOf(root, 'damaged'), { '0=ocfl_object_1.1': 'wrong\n' });

      const { ids, damaged } = await listed(root);

      assert.deepStrictEqual(ids, ['good']);
      assert.deepStrictEqual(damaged, [{ code: 'INVALID_OBJECT', ocflCode: 'E007', objectRoot: 'damaged' }]);
    });
  });

  it('leaves out an object that is being created and is not committed yet', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    let during: Awaited<ReturnType<typeof listed>> | undefined;

    await root.create('new', DETAILS, async (draft) => {
      await draft.write('a.txt', 'new');
      during = await listed(root);
    });

    assert.deepStrictEqual(during?.ids, ['a']);
    assert.deepStrictEqual(during?.damaged, []);
    assert.deepStrictEqual((await listed(root)).ids, ['a', 'new']);
  });

  it('yields an object whose create commits while the listing is opening it', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    const { objectRoot, lock } = placesOf(root, 'a');
    const aside = path.join(root.path, 'extensions', 'aside');
    const inventoryFiles = ['inventory.json', 'inventory.json.sha512'];
    for (const name of inventoryFiles) {
      await fs.promises.mkdir(aside, { recursive: true });
      await fs.promises.rename(path.join(objectRoot, name), path.join(aside, name));
    }
    const real = fs.promises.stat;
    mock.method(fs.promises, 'stat', async (...args: Parameters<typeof real>) => {
      if (String(args[0]) === lock) {
        for (const name of inventoryFiles) {
          await fs.promises.rename(path.join(aside, name), path.join(objectRoot, name));
        }
      }
      return real.apply(fs.promises, args);
    });

    const { ids, damaged } = await listed(root);

    assert.deepStrictEqual(ids, ['a']);
    assert.deepStrictEqual(damaged, []);
  });

  it('leaves out an object that is removed while the listing is opening it', async () => {
    const root = await newRoot();
    const { objectRoot, lock } = placesOf(root, 'gone');
    await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
    const real = fs.promises.stat;
    mock.method(fs.promises, 'stat', async (...args: Parameters<typeof real>) => {
      if (String(args[0]) === lock) {
        await fs.promises.rm(objectRoot, { recursive: true, force: true });
      }
      return real.apply(fs.promises, args);
    });

    assert.deepStrictEqual(await listed(root), { objects: [], damaged: [], ids: [] });
  });

  it('leaves out a directory that is removed before the listing reaches it', async () => {
    const root = await newRoot({ extensionName: PATH_DIRECT });
    await createObject(root, 'kept/a', { 'a.txt': 'a' });
    await createObject(root, 'gone/b', { 'a.txt': 'b' });
    const gone = path.join(root.path, 'gone');
    const real = fs.promises.opendir;
    mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof real>) => {
      if (String(args[0]) === gone) {
        await fs.promises.rm(gone, { recursive: true });
      }
      return real.apply(fs.promises, args);
    });

    const { ids, damaged } = await listed(root);

    assert.deepStrictEqual(ids, ['kept/a']);
    assert.deepStrictEqual(damaged, []);
  });

  describe('a file system error', () => {
    it('is thrown, ending the listing, when a directory cannot be opened', async () => {
      const root = await threeObjects();
      const secondLevel = (dirPath: string) => path.relative(root.path, dirPath).split(path.sep).length === 2;

      const opened = await trackOpendir(() => withFsFailure('opendir', secondLevel, () => assert.rejects(listed(root), { code: 'EIO' })));

      assert.ok(opened.length > 1);
      assert.deepStrictEqual(await stillOpen(opened), []);
    });

    it('is thrown, ending the listing, when an object declaration cannot be read', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      const objectRoot = objectRootOf(root, 'a');
      const declaration = (file: string) => path.dirname(file) === objectRoot && path.basename(file).startsWith('0=');

      const opened = await trackOpendir(() => withFsFailure('readFile', declaration, () => assert.rejects(listed(root), { code: 'EACCES' }), 'EACCES'));

      assert.ok(opened.length > 0);
      assert.deepStrictEqual(await stillOpen(opened), []);
    });

    it('is thrown, ending the listing, when an inventory cannot be read', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      const inventory = path.join(objectRootOf(root, 'a'), 'inventory.json');

      await withFsFailure('readFile', inventory, () => assert.rejects(listed(root), { code: 'EACCES' }), 'EACCES');
    });

    it('is thrown when the storage root itself has gone', async () => {
      const root = await newRoot();
      await fs.promises.rm(root.path, { recursive: true });

      await assert.rejects(listed(root), { code: 'ENOENT' });
    });
  });

  describe('the directories it opens', () => {
    it('never include the extensions directory, even while an update is in progress', async () => {
      const root = await threeObjects();
      const extensions = path.join(root.path, 'extensions');
      let opened: fs.Dir[] = [];

      await (await root.open('a')).update(DETAILS, async (draft) => {
        await writeB(draft);
        assert.ok(fs.existsSync(path.join(extensions, 'ocfl-js-workspace')));
        opened = await trackOpendir(async () => {
          assert.deepStrictEqual((await listed(root)).ids, ['a', 'b', 'c']);
        });
      });

      assert.ok(opened.length > 1);
      assert.deepStrictEqual(
        opened.map((d) => d.path).filter((p) => p === extensions || p.startsWith(extensions + path.sep)),
        [],
      );
    });

    it('are all closed when the loop breaks early', async () => {
      const root = await threeObjects();

      const opened = await trackOpendir(async () => {
        for await (const _found of root.objects()) {
          break;
        }
      });

      assert.ok(opened.length > 1);
      assert.deepStrictEqual(await stillOpen(opened), []);
    });

    it('are all closed when the loop body throws', async () => {
      const root = await threeObjects();

      const opened = await trackOpendir(() =>
        assert.rejects(async () => {
          for await (const _found of root.objects()) {
            throw new Error('stop');
          }
        }, /stop/),
      );

      assert.ok(opened.length > 1);
      assert.deepStrictEqual(await stillOpen(opened), []);
    });
  });
});
