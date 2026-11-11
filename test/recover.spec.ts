import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { Draft, StorageRoot } from '../src/index.ts';
import { emptyDirectoriesUnder } from './empty-directories.ts';
import { withFsFailure } from './fs-failures.ts';
import { assertHolds, createObject, DETAILS, objectRootOf, sha512, snapshot, textFiles, useTempRoots, workspaceOf } from './helpers/drafts.ts';
import { HASHED } from './helpers/layouts.ts';
import { rewriteInventory } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

const ID = 'recovering';

const writeB = (draft: Draft) => draft.write('b.txt', 'b');
const writeC = (draft: Draft) => draft.write('c.txt', 'c');

describe('root.recover', () => {
  const { newRoot } = useTempRoots('ocfl-recover-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** Where the object `id` and its lock are, or would be, in `root` */
  function placesOf(root: StorageRoot, id = ID) {
    const workspace = path.join(workspaceOf(root), id);
    return { objectRoot: objectRootOf(root, id), workspace, lock: path.join(workspace, 'lock') };
  }

  /** A storage root holding the object {@link ID} at v1 */
  async function existingObject() {
    const root = await newRoot();
    const object = await createObject(root, ID, { 'a.txt': 'a' });
    return { root, object, ...placesOf(root), before: await snapshot(root.path) };
  }

  /** A storage root with no objects */
  async function emptyRoot() {
    const root = await newRoot();
    return { root, ...placesOf(root), before: await snapshot(root.path) };
  }

  /** Leaves `id` as a writer that died straight after taking its lock would */
  async function lockObject(root: StorageRoot, id = ID) {
    const { lock } = placesOf(root, id);
    await fs.promises.mkdir(path.dirname(lock), { recursive: true });
    await fs.promises.writeFile(lock, new Date().toISOString());
    return lock;
  }

  async function assertSidecarMatches(objectRoot: string) {
    const content = await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8');
    assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, 'inventory.json.sha512'), 'utf8'), `${sha512(content)} inventory.json`);
  }

  /** Asserts the object {@link ID} is unlocked, with no workspace left, and takes an update */
  async function assertUpdatable(root: StorageRoot, expected: Record<string, string>) {
    assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
    const updated = await (await root.open(ID)).update(DETAILS, writeC);
    await assertHolds(root, updated, { ...expected, 'c.txt': 'c' });
  }

  describe('with nothing to clear', () => {
    it('resolves for a healthy, unlocked object and changes nothing on disk', async () => {
      const { root, before } = await existingObject();

      assert.strictEqual(await root.recover(ID), undefined);

      assert.deepStrictEqual(await snapshot(root.path), before);
    });

    it('throws OBJECT_NOT_FOUND for an id with no object and no leftovers', async () => {
      const { root, before } = await emptyRoot();

      await assert.rejects(root.recover(ID), ocflError('OBJECT_NOT_FOUND'));

      assert.deepStrictEqual(await snapshot(root.path), before);
    });

    it('throws OBJECT_NOT_FOUND for an empty directory where the object would be, and keeps it', async () => {
      const { root, objectRoot } = await emptyRoot();
      await fs.promises.mkdir(objectRoot);

      await assert.rejects(root.recover(ID), ocflError('OBJECT_NOT_FOUND'));

      assert.ok(fs.existsSync(objectRoot));
    });

    it('throws a TypeError for a missing id', async () => {
      const { root } = await emptyRoot();

      await assert.rejects(root.recover(''), TypeError);
    });
  });

  describe('a lock with nothing else left', () => {
    it('is released, leaving the object as it was and updatable', async () => {
      const { root, before } = await existingObject();
      await lockObject(root);

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('is released after an update that was refused could not release it', async () => {
      const { root, object, lock, before } = await existingObject();
      const stale = await root.open(ID);
      await object.update(DETAILS, writeB);
      await assert.rejects(
        withFsFailure('rm', lock, () => stale.update(DETAILS, writeC), 'EACCES'),
        ocflError('RECOVERY_NEEDED'),
      );

      await root.recover(ID);

      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
      assert.notDeepStrictEqual(await snapshot(root.path), before);
      assert.strictEqual((await root.open(ID)).head.number, 2);
    });

    it('is released for an object that was never created, without throwing OBJECT_NOT_FOUND', async () => {
      const { root, before } = await emptyRoot();
      await lockObject(root);

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
      await assert.rejects(root.recover(ID), ocflError('OBJECT_NOT_FOUND'));
    });

    it("leaves another object's lock and leftovers untouched", async () => {
      const { root } = await existingObject();
      await createObject(root, 'other', { 'a.txt': 'a' });
      await lockObject(root);
      const otherLock = await lockObject(root, 'other');
      const otherVersion = path.join(placesOf(root, 'other').workspace, 'v2', 'content', 'b.txt');
      await fs.promises.mkdir(path.dirname(otherVersion), { recursive: true });
      await fs.promises.writeFile(otherVersion, 'b');
      const others = await snapshot(placesOf(root, 'other').workspace);

      await root.recover(ID);

      assert.ok(!fs.existsSync(placesOf(root).workspace));
      assert.ok(fs.existsSync(otherLock));
      assert.deepStrictEqual(await snapshot(placesOf(root, 'other').workspace), others);
      await assert.rejects((await root.open('other')).update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
    });
  });

  /** Runs `write`, which must throw `RECOVERY_NEEDED`, with the root inventory unable to be replaced and the staged one unable to be removed */
  async function failBeforeCommit(objectRoot: string, write: () => Promise<unknown>) {
    await withFsFailure('rename', path.join(objectRoot, 'inventory.json'), () =>
      withFsFailure('rm', path.join(objectRoot, 'inventory.json.tmp'), () => assert.rejects(write(), ocflError('RECOVERY_NEEDED')), 'EACCES'),
    );
  }

  /** Runs `write`, which must throw `RECOVERY_NEEDED`, with the sidecar of the root inventory unable to be replaced */
  async function failAfterCommit(objectRoot: string, write: () => Promise<unknown>) {
    await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => assert.rejects(write(), ocflError('RECOVERY_NEEDED')));
  }

  describe('after an update that was not committed', () => {
    it('removes the version moved into the object and the staged inventory files, and the object opens at its previous head', async () => {
      const { root, object, objectRoot, before } = await existingObject();
      await failBeforeCommit(objectRoot, () => object.update(DETAILS, writeB));
      assert.deepStrictEqual(
        ['v2', 'inventory.json.tmp', 'inventory.json.sha512.tmp'].filter((name) => !fs.existsSync(path.join(objectRoot, name))),
        [],
      );

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
      const reopened = await root.open(ID);
      assert.strictEqual(reopened.head.number, 1);
      assert.deepStrictEqual(await textFiles(reopened.head), { 'a.txt': 'a' });
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('removes the unfinished version a dead writer left in the workspace', async () => {
      const { root, workspace, before } = await existingObject();
      await lockObject(root);
      for (const file of ['content/b.txt', '.staged-2', 'inventory.json']) {
        await fs.promises.mkdir(path.dirname(path.join(workspace, 'v2', file)), { recursive: true });
        await fs.promises.writeFile(path.join(workspace, 'v2', file), 'unfinished');
      }

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('discards an update whose undo failed', async () => {
      const { root, object, workspace, before } = await existingObject();
      const update = () =>
        object.update(DETAILS, async (draft) => {
          await writeB(draft);
          throw new Error('callback failed');
        });
      await withFsFailure('rm', path.join(workspace, 'v2'), () => assert.rejects(update(), ocflError('RECOVERY_NEEDED')), 'EACCES');
      assert.ok(fs.existsSync(path.join(workspace, 'v2')));

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.strictEqual((await root.open(ID)).head.number, 1);
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('gives the same result when called twice', async () => {
      const { root, object, objectRoot, before } = await existingObject();
      await failBeforeCommit(objectRoot, () => object.update(DETAILS, writeB));

      await root.recover(ID);
      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });

    it('keeps the lock when it cannot remove something, and finishes when called again', async () => {
      const { root, object, objectRoot, lock, before } = await existingObject();
      await failBeforeCommit(objectRoot, () => object.update(DETAILS, writeB));

      await assert.rejects(
        withFsFailure('rm', path.join(objectRoot, 'v2'), () => root.recover(ID), 'EACCES'),
        /injected failure/,
      );

      assert.ok(fs.existsSync(lock));
      await root.recover(ID);
      assert.deepStrictEqual(await snapshot(root.path), before);
    });
  });

  describe('after an update that was committed', () => {
    it('writes the matching sidecar, and the object opens at the new head and can be updated', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));

      await root.recover(ID);

      await assertSidecarMatches(objectRoot);
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1', 'v2']);
      const reopened = await root.open(ID);
      assert.strictEqual(reopened.head.number, 2);
      await assertHolds(root, reopened, { 'a.txt': 'a', 'b.txt': 'b' });
      await assertUpdatable(root, { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('writes the sidecar a committed create never got', async () => {
      const { root, objectRoot } = await emptyRoot();
      await failAfterCommit(objectRoot, () => root.create(ID, DETAILS, writeB));

      await root.recover(ID);

      await assertSidecarMatches(objectRoot);
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1']);
      await assertUpdatable(root, { 'b.txt': 'b' });
    });

    it('writes a missing sidecar when the staged one is gone too', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));
      await fs.promises.rm(path.join(objectRoot, 'inventory.json.sha512.tmp'));
      await fs.promises.rm(path.join(objectRoot, 'inventory.json.sha512'));

      await root.recover(ID);

      await assertSidecarMatches(objectRoot);
    });

    it('gives the same result when called twice', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));
      await root.recover(ID);
      const once = await snapshot(root.path);

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), once);
    });

    it('only releases the lock of an update that was finished but could not release it', async () => {
      const { root, object, lock } = await existingObject();
      await assert.rejects(
        withFsFailure('rm', lock, () => object.update(DETAILS, writeB), 'EACCES'),
        ocflError('RECOVERY_NEEDED'),
      );
      const { [path.relative(root.path, lock)]: _lock, ...committed } = await snapshot(root.path);

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), committed);
      await assertUpdatable(root, { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('throws INVALID_OBJECT, changing nothing, when the root inventory matches neither its sidecar nor its head version', async () => {
      const { root, objectRoot, lock } = await existingObject();
      await lockObject(root);
      const inventory = path.join(objectRoot, 'inventory.json');
      await fs.promises.writeFile(inventory, `${await fs.promises.readFile(inventory, 'utf8')}\n`);
      const damaged = await snapshot(root.path);

      await assert.rejects(root.recover(ID), ocflError('INVALID_OBJECT'));

      assert.deepStrictEqual(await snapshot(root.path), damaged);
      assert.ok(fs.existsSync(lock));
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT, changing nothing, when the directory holds an object with another id', async () => {
      const { root, objectRoot, lock } = await existingObject();
      await lockObject(root);
      await rewriteInventory(objectRoot, (inventory) => {
        inventory.id = 'another';
      });
      const held = await snapshot(root.path);

      await assert.rejects(root.recover(ID), ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));

      assert.deepStrictEqual(await snapshot(root.path), held);
      assert.ok(fs.existsSync(lock));
    });
  });

  describe('after a create that was not committed', () => {
    it('removes the object root and declaration the create made, and the object is not found', async () => {
      const { root, objectRoot, before } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json.sha512.tmp', 'inventory.json.tmp', 'v1']);

      await root.recover(ID);

      assert.ok(!fs.existsSync(objectRoot));
      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
      await assertHolds(root, await root.create(ID, DETAILS, writeB), { 'b.txt': 'b' });
    });

    it('removes the layout directories the create made above the object root', async () => {
      const root = await newRoot({ extensionName: HASHED });
      const before = await snapshot(root.path);
      const directories = await fs.promises.readdir(root.path);
      const failing = (source: string, target: string) => path.basename(source) === 'inventory.json.tmp' || path.basename(target) === 'inventory.json';
      await withFsFailure('rename', failing, () =>
        withFsFailure('rm', failing, () => assert.rejects(root.create(ID, DETAILS, writeB), ocflError('RECOVERY_NEEDED')), 'EACCES'),
      );
      assert.notDeepStrictEqual(await snapshot(root.path), before);

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.deepStrictEqual(await fs.promises.readdir(root.path), directories);
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });

    it('keeps an object root that existed before the create, and empties it', async () => {
      const { root, objectRoot } = await emptyRoot();
      await fs.promises.mkdir(objectRoot);
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));

      await root.recover(ID);

      assert.deepStrictEqual(await fs.promises.readdir(objectRoot), []);
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
      await assertHolds(root, await root.create(ID, DETAILS, writeB), { 'b.txt': 'b' });
    });

    it('removes the unfinished first version of a create that never reached the object root', async () => {
      const { root, objectRoot, workspace, before } = await emptyRoot();
      const create = () =>
        root.create(ID, DETAILS, async (draft) => {
          await writeB(draft);
          throw new Error('callback failed');
        });
      await withFsFailure('rm', path.join(workspace, 'v1'), () => assert.rejects(create(), ocflError('RECOVERY_NEEDED')), 'EACCES');

      await root.recover(ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(objectRoot));
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
    });

    it('removes a declaration with no inventory even when the lock is gone, keeping its directory', async () => {
      const { root, objectRoot, lock } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      await fs.promises.rm(lock);

      await root.recover(ID);

      assert.deepStrictEqual(await fs.promises.readdir(objectRoot), []);
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
    });

    it('leaves the disk as it is when called again, and then throws OBJECT_NOT_FOUND', async () => {
      const { root, objectRoot, before } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      await root.recover(ID);

      await assert.rejects(root.recover(ID), ocflError('OBJECT_NOT_FOUND'));

      assert.deepStrictEqual(await snapshot(root.path), before);
    });
  });

  describe('the RECOVERY_NEEDED error', () => {
    it('tells the caller to recover the object', async () => {
      const { object, objectRoot } = await existingObject();

      await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => assert.rejects(object.update(DETAILS, writeB), /recover\(\)/));
    });
  });
});
