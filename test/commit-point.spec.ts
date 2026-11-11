import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { withFsFailure, withLostReply } from './fs-failures.ts';
import { DETAILS, objectAtV1, placesOf, readInventory, sidecarMatches, snapshot, textFiles, useTempRoots, writeB } from './helpers/drafts.ts';
import { ocflError, rejection } from './ocfl-error.ts';

const ID = 'committing';
const INJECTED = /injected failure/;

const recoveryNeeded = (promise: Promise<unknown>) => rejection(promise, 'RECOVERY_NEEDED');

describe('the commit point', () => {
  const { newRoot } = useTempRoots('ocfl-commit-point-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** A storage root holding the object {@link ID} at v1, and where its files and lock are */
  const existingObject = async () => objectAtV1(await newRoot(), ID);

  /** A storage root with no objects, and where the object {@link ID} and its lock would be */
  async function emptyRoot() {
    const root = await newRoot();
    return { root, ...placesOf(root, ID) };
  }

  /** The root inventory on disk and whether its sidecar records its digest */
  async function rootInventory(objectRoot: string) {
    return { head: (await readInventory(objectRoot)).head, sidecarMatches: await sidecarMatches(objectRoot) };
  }

  describe('when replacing the sidecar fails, after the root inventory was replaced', () => {
    it('throws RECOVERY_NEEDED from an update, with the failure as its cause, and keeps the new root inventory and the lock', async () => {
      const { root, object, objectRoot, lock, before } = await existingObject();

      const error = await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => recoveryNeeded(object.update(DETAILS, writeB)));

      assert.match((error.cause as Error).message, INJECTED);
      assert.deepStrictEqual(await rootInventory(objectRoot), { head: 'v2', sidecarMatches: false });
      assert.strictEqual((await snapshot(objectRoot))['inventory.json.sha512'], before['inventory.json.sha512']);
      assert.ok(fs.existsSync(lock));
      const reopened = await root.open(ID);
      assert.deepStrictEqual(await textFiles(reopened.head), { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('throws RECOVERY_NEEDED from a create, and keeps the new root inventory and the lock', async () => {
      const { root, objectRoot, lock } = await emptyRoot();

      const error = await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => recoveryNeeded(root.create(ID, DETAILS, writeB)));

      assert.match((error.cause as Error).message, INJECTED);
      assert.strictEqual((await readInventory(objectRoot)).head, 'v1');
      assert.ok(!fs.existsSync(path.join(objectRoot, 'inventory.json.sha512')));
      assert.ok(fs.existsSync(lock));
      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'b.txt': 'b' });
    });

    it('leaves the object the update was called on as it was', async () => {
      const { object, objectRoot } = await existingObject();

      await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => recoveryNeeded(object.update(DETAILS, writeB)));

      assert.strictEqual(object.head.number, 1);
      assert.deepStrictEqual([...object.versions.keys()], [1]);
      assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'a' });
    });

    it('refuses later updates of the object with UPDATE_IN_PROGRESS', async () => {
      const { root, object, objectRoot } = await existingObject();
      await withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => recoveryNeeded(object.update(DETAILS, writeB)));
      const after = await snapshot(root.path);

      await assert.rejects(object.update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
      await assert.rejects((await root.open(ID)).update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));

      assert.deepStrictEqual(await snapshot(root.path), after);
    });
  });

  describe('when replacing the root inventory reports a failure but has happened', () => {
    it('throws RECOVERY_NEEDED from an update, with the failure as its cause, and undoes nothing', async () => {
      const { root, object, objectRoot, lock } = await existingObject();

      const error = await withLostReply('rename', path.join(objectRoot, 'inventory.json'), () => recoveryNeeded(object.update(DETAILS, writeB)));

      assert.match((error.cause as Error).message, INJECTED);
      assert.deepStrictEqual(await rootInventory(objectRoot), { head: 'v2', sidecarMatches: false });
      assert.ok(fs.existsSync(path.join(objectRoot, 'v2', 'content', 'b.txt')));
      assert.ok(fs.existsSync(lock));
      assert.strictEqual(object.head.number, 1);
      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'a.txt': 'a', 'b.txt': 'b' });

      await root.recover(ID);
      assert.deepStrictEqual(await rootInventory(objectRoot), { head: 'v2', sidecarMatches: true });
      assert.ok(!fs.existsSync(lock));
    });

    it('throws RECOVERY_NEEDED from a create, and keeps the created object and the lock', async () => {
      const { root, objectRoot, lock } = await emptyRoot();

      const error = await withLostReply('rename', path.join(objectRoot, 'inventory.json'), () => recoveryNeeded(root.create(ID, DETAILS, writeB)));

      assert.match((error.cause as Error).message, INJECTED);
      assert.ok(fs.existsSync(lock));
      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'b.txt': 'b' });
    });

    it('throws RECOVERY_NEEDED, undoing nothing, when the root inventory cannot be read to tell whether it was replaced', async () => {
      const { root, object, objectRoot, lock, before } = await existingObject();
      const inventory = path.join(objectRoot, 'inventory.json');
      let renameFailed = false;
      const failingRename = (_source: string, target: string) => {
        renameFailed ||= target === inventory;
        return target === inventory;
      };

      const error = await withFsFailure('rename', failingRename, () =>
        withFsFailure(
          'readFile',
          (file) => renameFailed && file === inventory,
          () => recoveryNeeded(object.update(DETAILS, writeB)),
          'EACCES',
        ),
      );

      assert.strictEqual((error.cause as NodeJS.ErrnoException).code, 'EIO');
      assert.ok(fs.existsSync(path.join(objectRoot, 'v2', 'content', 'b.txt')));
      assert.ok(fs.existsSync(lock));

      await root.recover(ID);
      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assert.strictEqual((await root.open(ID)).head.number, 1);
    });
  });

  describe('when the lock cannot be removed after a commit', () => {
    it('throws RECOVERY_NEEDED from an update, with the failure as its cause, and keeps the committed version and the lock', async () => {
      const { root, object, objectRoot, lock } = await existingObject();

      const error = await withFsFailure('rm', lock, () => recoveryNeeded(object.update(DETAILS, writeB)), 'EACCES');

      assert.match((error.cause as Error).message, INJECTED);
      assert.deepStrictEqual(await rootInventory(objectRoot), { head: 'v2', sidecarMatches: true });
      assert.ok(fs.existsSync(lock));
      assert.strictEqual(object.head.number, 1);
      await assert.rejects((await root.open(ID)).update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
    });

    it('throws RECOVERY_NEEDED from a create, and keeps the created object and the lock', async () => {
      const { root, objectRoot, lock } = await emptyRoot();

      await withFsFailure('rm', lock, () => recoveryNeeded(root.create(ID, DETAILS, writeB)), 'EACCES');

      assert.deepStrictEqual(await rootInventory(objectRoot), { head: 'v1', sidecarMatches: true });
      assert.ok(fs.existsSync(lock));
    });
  });

  describe('when a failed update cannot be undone', () => {
    it('throws RECOVERY_NEEDED with the failure of the commit step, not of the undo, as its cause, and keeps the lock', async () => {
      const { root, object, objectRoot, lock, before } = await existingObject();

      const error = await withFsFailure('rename', path.join(objectRoot, 'inventory.json'), () =>
        withFsFailure('rm', path.join(objectRoot, 'v2'), () => recoveryNeeded(object.update(DETAILS, writeB)), 'EACCES'),
      );

      assert.deepStrictEqual(
        { message: (error.cause as Error).message, code: (error.cause as NodeJS.ErrnoException).code },
        { message: 'injected failure', code: 'EIO' },
      );
      assert.strictEqual((await snapshot(objectRoot))['inventory.json'], before['inventory.json']);
      assert.ok(fs.existsSync(lock));
      assert.strictEqual(object.head.number, 1);
      assert.strictEqual((await root.open(ID)).head.number, 1);
      await assert.rejects(object.update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
    });

    it("throws RECOVERY_NEEDED with the callback's error as its cause, and keeps the lock", async () => {
      const { object, workspace, lock, objectRoot, before } = await existingObject();
      const failure = new Error('callback failed');

      const error = await withFsFailure(
        'rm',
        path.join(workspace, 'v2'),
        () =>
          recoveryNeeded(
            object.update(DETAILS, async (draft) => {
              await writeB(draft);
              throw failure;
            }),
          ),
        'EACCES',
      );

      assert.strictEqual(error.cause, failure);
      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assert.ok(fs.existsSync(lock));
      await assert.rejects(object.update(DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
    });

    it('throws RECOVERY_NEEDED from a create, and the object still does not exist', async () => {
      const { root, workspace, lock } = await emptyRoot();
      const failure = new Error('callback failed');

      const error = await withFsFailure(
        'rm',
        path.join(workspace, 'v1'),
        () =>
          recoveryNeeded(
            root.create(ID, DETAILS, async (draft) => {
              await writeB(draft);
              throw failure;
            }),
          ),
        'EACCES',
      );

      assert.strictEqual(error.cause, failure);
      assert.ok(fs.existsSync(lock));
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
      await assert.rejects(root.create(ID, DETAILS, writeB), ocflError('UPDATE_IN_PROGRESS'));
    });

    it('throws RECOVERY_NEEDED with the refusal as its cause when the lock of an out-of-date object cannot be released', async () => {
      const { object, lock } = await existingObject();
      await object.update(DETAILS, writeB);

      const error = await withFsFailure('rm', lock, () => recoveryNeeded(object.update(DETAILS, writeB)), 'EACCES');

      assert.ok(ocflError('OBJECT_OUT_OF_DATE')(error.cause));
      assert.ok(fs.existsSync(lock));
    });

    it('throws RECOVERY_NEEDED when an update that changes nothing cannot release the lock', async () => {
      const { object, lock } = await existingObject();

      const error = await withFsFailure('rm', lock, () => recoveryNeeded(object.update(DETAILS, (draft) => draft.write('a.txt', 'a'))), 'EACCES');

      assert.match((error.cause as Error).message, INJECTED);
      assert.ok(fs.existsSync(lock));
    });
  });
});
