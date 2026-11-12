import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { StorageRoot } from '../src/index.ts';
import {
  assertHolds,
  assertNoWorkspace,
  createObject,
  DETAILS,
  lockObject,
  objectAtV1,
  placesOf,
  recover,
  sidecarMatches,
  snapshot,
  textFiles,
  useTempRoots,
  workspaceOf,
  writeB,
  writeC,
} from './helpers/drafts.ts';
import { emptyDirectoriesUnder } from './helpers/empty-directories.ts';
import { withFsFailure } from './helpers/fs-failures.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { rewriteInventory, writeFiles } from './helpers/storage-roots.ts';

const ID = 'recovering';

describe('root.recover', () => {
  const { newRoot } = useTempRoots('ocfl-recover-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** A storage root holding the object {@link ID} at v1, and what the whole root holds */
  async function existingObject() {
    const existing = await objectAtV1(await newRoot(), ID);
    return { ...existing, before: await snapshot(existing.root.path) };
  }

  /** A storage root with no objects */
  async function emptyRoot() {
    const root = await newRoot();
    return { root, ...placesOf(root, ID), before: await snapshot(root.path) };
  }

  /** Asserts the object {@link ID} is unlocked, with no workspace left, and takes an update */
  async function assertUpdatable(root: StorageRoot, expected: Record<string, string>) {
    assertNoWorkspace(root);
    const updated = await (await root.open(ID)).update(DETAILS, writeC);
    await assertHolds(root, updated, { ...expected, 'c.txt': 'c' });
  }

  describe('with nothing to clear', () => {
    it('has no unfinished write for a healthy, unlocked object, and changes nothing on disk', async () => {
      const { root, before } = await existingObject();

      assert.strictEqual(await root.unfinishedWrite(ID), undefined);

      assert.deepStrictEqual(await snapshot(root.path), before);
    });

    it('has no unfinished write for an id with no object and no leftovers, and changes nothing', async () => {
      const { root, before } = await emptyRoot();

      assert.strictEqual(await root.unfinishedWrite(ID), undefined);

      assert.deepStrictEqual(await snapshot(root.path), before);
    });

    it('has no unfinished write for an empty directory where the object would be, and keeps it', async () => {
      const { root, objectRoot } = await emptyRoot();
      await fs.promises.mkdir(objectRoot);

      assert.strictEqual(await root.unfinishedWrite(ID), undefined);

      assert.ok(fs.existsSync(objectRoot));
    });

    it('throws a TypeError for a missing id', async () => {
      const { root } = await emptyRoot();

      await assert.rejects(recover(root, ''), TypeError);
    });
  });

  describe('a lock with nothing else left', () => {
    it('is released, leaving the object as it was and updatable', async () => {
      const { root, before } = await existingObject();
      await lockObject(root, ID);

      await recover(root, ID);

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

      await recover(root, ID);

      assertNoWorkspace(root);
      assert.notDeepStrictEqual(await snapshot(root.path), before);
      assert.strictEqual((await root.open(ID)).head.number, 2);
    });

    it('is released for an object that was never created', async () => {
      const { root, before } = await emptyRoot();
      await lockObject(root, ID);

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assertNoWorkspace(root);
      assert.strictEqual(await root.unfinishedWrite(ID), undefined);
    });

    it("leaves another object's lock and leftovers untouched", async () => {
      const { root } = await existingObject();
      await createObject(root, 'other', { 'a.txt': 'a' });
      await lockObject(root, ID);
      const otherLock = await lockObject(root, 'other');
      const otherVersion = path.join(placesOf(root, 'other').workspace, 'v2', 'content', 'b.txt');
      await fs.promises.mkdir(path.dirname(otherVersion), { recursive: true });
      await fs.promises.writeFile(otherVersion, 'b');
      const others = await snapshot(placesOf(root, 'other').workspace);

      await recover(root, ID);

      assert.ok(!fs.existsSync(placesOf(root, ID).workspace));
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

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
      const reopened = await root.open(ID);
      assert.strictEqual(reopened.head.number, 1);
      assert.deepStrictEqual(await textFiles(reopened.head), { 'a.txt': 'a' });
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('removes the unfinished version a dead writer left in the workspace', async () => {
      const { root, workspace, before } = await existingObject();
      await lockObject(root, ID);
      await writeFiles(path.join(workspace, 'v2'), {
        'content/b.txt': 'unfinished',
        'content/lock': 'content, not a lock',
        'content/empty/lock': '',
        'content/year/lock': '2024',
        'content/noted/lock': `${new Date().toISOString()}\nnote`,
        'content/lined/lock': `${new Date().toISOString()}\nno-object-root\n`,
        'content/long/lock': `${new Date().toISOString()}\n${'x'.repeat(100)}`,
        '.staged-2': 'unfinished',
        'inventory.json': 'unfinished',
      });

      await recover(root, ID);

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

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.strictEqual((await root.open(ID)).head.number, 1);
      await assertUpdatable(root, { 'a.txt': 'a' });
    });

    it('gives the same result when called twice', async () => {
      const { root, object, objectRoot, before } = await existingObject();
      await failBeforeCommit(objectRoot, () => object.update(DETAILS, writeB));
      const write = await root.unfinishedWrite(ID);

      await write?.recover();
      await write?.recover();

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });

    it('keeps the lock when it cannot remove something, and finishes when called again', async () => {
      const { root, object, objectRoot, lock, before } = await existingObject();
      await failBeforeCommit(objectRoot, () => object.update(DETAILS, writeB));

      await assert.rejects(
        withFsFailure('rm', path.join(objectRoot, 'v2'), () => recover(root, ID), 'EACCES'),
        /injected failure/,
      );

      assert.ok(fs.existsSync(lock));
      await recover(root, ID);
      assert.deepStrictEqual(await snapshot(root.path), before);
    });
  });

  describe('after an update that was committed', () => {
    it('writes the matching sidecar, and the object opens at the new head and can be updated', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));

      await recover(root, ID);

      assert.ok(await sidecarMatches(objectRoot));
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1', 'v2']);
      const reopened = await root.open(ID);
      assert.strictEqual(reopened.head.number, 2);
      await assertHolds(root, reopened, { 'a.txt': 'a', 'b.txt': 'b' });
      await assertUpdatable(root, { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('writes the sidecar a committed create never got', async () => {
      const { root, objectRoot } = await emptyRoot();
      await failAfterCommit(objectRoot, () => root.create(ID, DETAILS, writeB));

      await recover(root, ID);

      assert.ok(await sidecarMatches(objectRoot));
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1']);
      await assertUpdatable(root, { 'b.txt': 'b' });
    });

    it('writes a missing sidecar when the staged one is gone too', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));
      await fs.promises.rm(path.join(objectRoot, 'inventory.json.sha512.tmp'));
      await fs.promises.rm(path.join(objectRoot, 'inventory.json.sha512'));

      await recover(root, ID);

      assert.ok(await sidecarMatches(objectRoot));
    });

    it('gives the same result when called twice', async () => {
      const { root, object, objectRoot } = await existingObject();
      await failAfterCommit(objectRoot, () => object.update(DETAILS, writeB));
      const write = await root.unfinishedWrite(ID);
      await write?.recover();
      const once = await snapshot(root.path);

      await write?.recover();

      assert.deepStrictEqual(await snapshot(root.path), once);
    });

    it('only releases the lock of an update that was finished but could not release it', async () => {
      const { root, object, lock } = await existingObject();
      await assert.rejects(
        withFsFailure('rm', lock, () => object.update(DETAILS, writeB), 'EACCES'),
        ocflError('RECOVERY_NEEDED'),
      );
      const { [path.relative(root.path, lock)]: _lock, ...committed } = await snapshot(root.path);

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), committed);
      await assertUpdatable(root, { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('throws INVALID_OBJECT, changing nothing, when the root inventory matches neither its sidecar nor its head version', async () => {
      const { root, objectRoot, lock } = await existingObject();
      await lockObject(root, ID);
      const inventory = path.join(objectRoot, 'inventory.json');
      await fs.promises.writeFile(inventory, `${await fs.promises.readFile(inventory, 'utf8')}\n`);
      const damaged = await snapshot(root.path);

      await assert.rejects(recover(root, ID), ocflError('INVALID_OBJECT'));

      assert.deepStrictEqual(await snapshot(root.path), damaged);
      assert.ok(fs.existsSync(lock));
    });

    it('releases the lock, leaving the object root alone, when the directory holds an object with another id', async () => {
      const { root, objectRoot } = await existingObject();
      await rewriteInventory(objectRoot, (inventory) => {
        inventory.id = 'another';
      });
      const held = await snapshot(objectRoot);
      await lockObject(root, ID);
      await writeFiles(path.join(placesOf(root, ID).workspace, 'v2'), { 'content/b.txt': 'unfinished' });

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(objectRoot), held);
      assertNoWorkspace(root);
    });
  });

  describe('after a create that was not committed', () => {
    it('removes the object root and declaration the create made, and the object is not found', async () => {
      const { root, objectRoot, before } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json.sha512.tmp', 'inventory.json.tmp', 'v1']);

      await recover(root, ID);

      assert.ok(!fs.existsSync(objectRoot));
      assert.deepStrictEqual(await snapshot(root.path), before);
      assertNoWorkspace(root);
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

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.deepStrictEqual(await fs.promises.readdir(root.path), directories);
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });

    it('keeps an object root that existed before the create, and empties it', async () => {
      const { root, objectRoot } = await emptyRoot();
      await fs.promises.mkdir(objectRoot);
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));

      await recover(root, ID);

      assert.deepStrictEqual(await fs.promises.readdir(objectRoot), []);
      assertNoWorkspace(root);
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

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(objectRoot));
      assertNoWorkspace(root);
    });

    it('is damage once the lock is gone: no unfinished write, and the object opens as INVALID_OBJECT', async () => {
      const { root, objectRoot, lock } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      await fs.promises.rm(lock);
      const left = await snapshot(root.path);

      assert.strictEqual(await root.unfinishedWrite(ID), undefined);
      await assert.rejects(root.open(ID), ocflError('INVALID_OBJECT', 'E063'));

      assert.deepStrictEqual(await snapshot(root.path), left);
    });

    it('keeps a first version that has no declaration beside it, and releases the lock', async () => {
      const { root, objectRoot, lock } = await emptyRoot();
      await writeFiles(path.join(objectRoot, 'v1'), { 'content/a.txt': 'a' });
      const held = await snapshot(objectRoot);
      await lockObject(root, ID);

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(objectRoot), held);
      assert.ok(!fs.existsSync(lock));
    });

    it('leaves no unfinished write, and the disk as it was', async () => {
      const { root, objectRoot, before } = await emptyRoot();
      await failBeforeCommit(objectRoot, () => root.create(ID, DETAILS, writeB));
      await recover(root, ID);

      assert.strictEqual(await root.unfinishedWrite(ID), undefined);

      assert.deepStrictEqual(await snapshot(root.path), before);
    });
  });

  describe('a version directory that no dead writer can have left', () => {
    /** {@link existingObject} with versions up to `head`, and what its object root then holds */
    async function objectAt(head: number) {
      const existing = await existingObject();
      let object = existing.object;
      for (let n = 2; n <= head; n++) {
        object = await object.update(DETAILS, (draft) => draft.write(`${n}.txt`, `${n}`));
      }
      return { ...existing, object, committed: await snapshot(existing.objectRoot) };
    }

    it('is kept, with INVALID_OBJECT, in a locked object of several versions that lost its root inventory', async () => {
      const { root, objectRoot, lock } = await objectAt(2);
      await fs.promises.rm(path.join(objectRoot, 'inventory.json'));
      await lockObject(root, ID);
      const damaged = await snapshot(root.path);

      await assert.rejects(recover(root, ID), ocflError('INVALID_OBJECT', 'E063'));

      assert.deepStrictEqual(await snapshot(root.path), damaged);
      assert.ok(fs.existsSync(lock));
    });

    it('is kept when it is not the version after the head', async () => {
      const { root, objectRoot, lock } = await objectAt(3);
      await lockObject(root, ID);
      await writeFiles(path.join(objectRoot, 'v5'), { 'content/stray.txt': 'stray' });
      const held = await snapshot(objectRoot);

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(objectRoot), held);
      assert.ok(!fs.existsSync(lock));
      assert.strictEqual((await root.open(ID)).head.number, 3);
    });

    it('is removed when it is the version after the head, which the root inventory does not name', async () => {
      const { root, objectRoot, lock, committed } = await objectAt(3);
      await lockObject(root, ID);
      await writeFiles(path.join(objectRoot, 'v4'), { 'content/unfinished.txt': 'unfinished' });

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(objectRoot), committed);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v4')));
      assert.ok(!fs.existsSync(lock));
      assert.strictEqual((await (await root.open(ID)).update(DETAILS, writeC)).head.number, 4);
    });

    it('is kept when the object can have no further version', async () => {
      const { root, objectRoot, lock } = await existingObject();
      await fs.promises.rename(path.join(objectRoot, 'v1'), path.join(objectRoot, 'v09'));
      await rewriteInventory(objectRoot, (inventory) => {
        inventory.head = 'v09';
        inventory.versions = { v09: inventory.versions!.v1! };
        inventory.manifest = Object.fromEntries(
          Object.entries(inventory.manifest!).map(([digest, paths]) => [digest, paths.map((file) => file.replace('v1/', 'v09/'))]),
        );
      });
      await lockObject(root, ID);
      await writeFiles(path.join(objectRoot, 'v10'), { 'content/stray.txt': 'stray' });
      const held = await snapshot(objectRoot);

      await recover(root, ID);

      assert.deepStrictEqual(await snapshot(objectRoot), held);
      assert.ok(!fs.existsSync(lock));
    });
  });

  describe('in a storage root holding an object another tool wrote where the layout puts none', () => {
    /** A path-direct storage root holding the objects `ids`, and then at `outer` a copy of another object */
    const holdingForeignOuter = async (...ids: string[]) => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      for (const id of [...ids, 'other']) {
        await createObject(root, id, { 'a.txt': 'a' });
      }
      await fs.promises.cp(path.join(root.path, 'other', '__object__'), path.join(root.path, 'outer'), { recursive: true });
      return root;
    };

    it('releases the lock and clears the workspace, but touches nothing in the storage root, for a write inside another object', async () => {
      const root = await holdingForeignOuter();
      await lockObject(root, 'outer/inner', undefined, 'outer/inner/__object__');
      await writeFiles(path.join(workspaceOf(root), 'outer', 'inner', '__object__', 'v1'), { 'content/b.txt': 'unfinished' });
      const held = await snapshot(path.join(root.path, 'outer'));

      await recover(root, 'outer/inner');

      assert.deepStrictEqual(await snapshot(path.join(root.path, 'outer')), held);
      assert.ok(!fs.existsSync(path.join(workspaceOf(root), 'outer')));
    });

    it('releases the lock, leaving the object root alone, for an object inside another object', async () => {
      const root = await holdingForeignOuter('outer/inner');
      await lockObject(root, 'outer/inner', undefined, 'outer/inner/__object__');
      await writeFiles(path.join(root.path, 'outer', 'inner', '__object__', 'v2'), { 'content/b.txt': 'unfinished' });
      const held = await snapshot(path.join(root.path, 'outer'));

      await recover(root, 'outer/inner');

      assert.deepStrictEqual(await snapshot(path.join(root.path, 'outer')), held);
      assert.strictEqual(await root.unfinishedWrite('outer/inner'), undefined);
    });

    /** Leaves in the workspace of <corpus>, below its version name v1, another object's lock and unfinished version, as its live writer would */
    const foreignWorkspaceBelowVersion = async (root: StorageRoot, below: string) => {
      const foreign = path.join(workspaceOf(root), 'corpus', '__object__', 'v1', below);
      const lock = JSON.stringify({ id: 'foreign', lockedAt: new Date().toISOString(), objectRootExisted: true });
      await writeFiles(foreign, { lock, 'v2/content/b.txt': 'b' });
    };

    for (const below of ['', 'item/__object__']) {
      it(`is no unfinished write of the object whose version name holds another writer's lock at <v1/${below}>`, async () => {
        const root = await newRoot({ extensionName: PATH_DIRECT });
        await foreignWorkspaceBelowVersion(root, below);
        const held = await snapshot(root.path);

        assert.strictEqual(await root.unfinishedWrite('corpus'), undefined);

        assert.deepStrictEqual(await snapshot(root.path), held);
      });
    }

    it("releases its own lock but leaves another writer's workspace below its version name", async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      await createObject(root, 'corpus', { 'a.txt': 'a' });
      await foreignWorkspaceBelowVersion(root, '');
      const foreign = await snapshot(path.join(workspaceOf(root), 'corpus', '__object__', 'v1'));
      const lock = await lockObject(root, 'corpus', undefined, 'corpus/__object__');

      await recover(root, 'corpus');

      assert.ok(!fs.existsSync(lock));
      assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), 'corpus', '__object__', 'v1')), foreign);
    });
  });

  describe('when it cannot read what is there', () => {
    it('throws the file system error for a directory it cannot list, and keeps the lock', async () => {
      const { root, objectRoot, lock } = await existingObject();
      await lockObject(root, ID);

      await assert.rejects(
        withFsFailure('readdir', objectRoot, () => recover(root, ID), 'EACCES'),
        { code: 'EACCES' },
      );

      assert.ok(fs.existsSync(lock));
    });
  });

  describe('the RECOVERY_NEEDED error', () => {
    it("tells the caller to recover the object's unfinished write", async () => {
      const { object, objectRoot } = await existingObject();

      await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () =>
        assert.rejects(object.update(DETAILS, writeB), /recover its unfinished write/),
      );
    });
  });
});
