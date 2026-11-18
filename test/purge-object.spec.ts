import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createStorageRoot, type LayoutConfig, openStorageRoot, type StorageRoot } from '../src/index.ts';
import {
  assertHolds,
  assertNoWorkspace,
  attemptUpdate,
  createObject,
  DETAILS,
  lockObject,
  lockOf,
  objectAtV1,
  objectRootOf,
  recover,
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
import { ocflError, rejection } from './helpers/ocfl-error.ts';
import { writeFiles } from './helpers/storage-roots.ts';

const ID = 'purging';
const NESTED: LayoutConfig = { extensionName: PATH_DIRECT };
const DECLARATION = { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' };

describe('root.purge', () => {
  const temp = useTempRoots('ocfl-purge-object-');
  const { newRoot } = temp;
  afterEach(() => {
    mock.restoreAll();
  });

  /** A storage root holding the object {@link ID} at v1 */
  const existingObject = async () => objectAtV1(await newRoot(), ID);

  /** Asserts that purging `id` is refused with `code`, and that nothing in the storage root changes */
  async function assertRefused(root: StorageRoot, id: string, code: Parameters<typeof ocflError>[0], ocflCode?: string) {
    const before = await snapshot(root.path);
    const empty = await emptyDirectoriesUnder(root.path);
    await assert.rejects(root.purge(id), ocflError(code, ocflCode));
    assert.deepStrictEqual(await snapshot(root.path), before);
    assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), empty);
  }

  describe('of an object', () => {
    it('deletes it and every version, returning nothing', async () => {
      const { root, object, objectRoot } = await existingObject();
      await object.update(DETAILS, writeB);

      assert.strictEqual(await root.purge(ID), undefined);

      assert.ok(!fs.existsSync(objectRoot));
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
      assertNoWorkspace(root);
    });

    it('deletes the parent directories it leaves empty, keeping the storage root', async () => {
      const root = await newRoot({ extensionName: HASHED });
      await createObject(root, ID, { 'a.txt': 'a' });
      const before = await fs.promises.readdir(root.path);

      await root.purge(ID);

      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
      assert.deepStrictEqual((await fs.promises.readdir(root.path)).sort(), before.filter((name) => !/^[0-9a-f]{3}$/.test(name)).sort());
      assert.deepStrictEqual((await openStorageRoot(root.path)).layout, root.layout);
    });

    it('keeps sibling objects and the parent directories they share', async () => {
      const root = await newRoot(NESTED);
      await createObject(root, 'collection/nested/removed', { 'a.txt': 'a' });
      await createObject(root, 'collection/sibling', { 'a.txt': 'sibling' });

      await root.purge('collection/nested/removed');

      assert.ok(!fs.existsSync(path.join(root.path, 'collection', 'nested')));
      assert.deepStrictEqual(await textFiles((await root.open('collection/sibling')).head), { 'a.txt': 'sibling' });
    });

    it('succeeds when a parent directory left empty cannot be removed', { skip: process.getuid?.() === 0 }, async () => {
      const root = await newRoot(NESTED);
      await createObject(root, 'collection/nested/removed', { 'a.txt': 'a' });
      const leftover = path.join(root.path, 'collection', 'nested');
      const readOnly = path.dirname(leftover);
      await fs.promises.chmod(readOnly, 0o555);
      try {
        await root.purge('collection/nested/removed');
      } finally {
        await fs.promises.chmod(readOnly, 0o755);
      }

      assert.deepStrictEqual(await fs.promises.readdir(leftover), []);
      await assert.rejects(root.open('collection/nested/removed'), ocflError('OBJECT_NOT_FOUND'));
    });

    it('lets an object with the same id be created and updated afterwards', async () => {
      const { root } = await existingObject();

      await root.purge(ID);
      const recreated = await createObject(root, ID, { 'new.txt': 'new' });
      const updated = await recreated.update(DETAILS, writeC);

      await assertHolds(root, updated, { 'new.txt': 'new', 'c.txt': 'c' });
      assert.strictEqual(updated.head.number, 2);
    });

    it('makes an object opened before it out of date, refusing its update before the callback runs', async () => {
      const { root, object } = await existingObject();
      await root.purge(ID);

      const { result, called } = await attemptUpdate(object);

      await assert.rejects(result, ocflError('OBJECT_OUT_OF_DATE'));
      assert.strictEqual(called(), false);
      assert.ok(!fs.existsSync(objectRootOf(root, ID)));
      assertNoWorkspace(root);
      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
    });

    it('makes an object opened before it out of date, even once an object with the same id is created', async () => {
      const { root, object } = await existingObject();
      await root.purge(ID);
      const recreated = await createObject(root, ID, { 'new.txt': 'new' });

      await assert.rejects(object.update(DETAILS, writeC), ocflError('OBJECT_OUT_OF_DATE'));

      await assertHolds(root, recreated, { 'new.txt': 'new' });
      assertNoWorkspace(root);
    });

    it('is no longer listed', async () => {
      const { root } = await existingObject();
      await createObject(root, 'kept', { 'a.txt': 'a' });

      await root.purge(ID);

      const ids = [];
      for await (const entry of root.objects()) {
        ids.push(entry.status === 'opened' ? entry.object.id : entry);
      }
      assert.deepStrictEqual(ids, ['kept']);
    });

    it("leaves a sibling's update in progress alone, deleting only its own workspace directories", async () => {
      const root = await newRoot(NESTED);
      await createObject(root, 'collection/nested/removed', { 'a.txt': 'a' });
      const sibling = await createObject(root, 'collection/sibling', { 'a.txt': 'a' });

      const updated = await sibling.update(DETAILS, async (draft) => {
        await writeB(draft);
        await root.purge('collection/nested/removed');
        assert.ok(!fs.existsSync(path.join(workspaceOf(root), 'collection', 'nested')));
      });

      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b' });
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });
  });

  describe('while the object is locked', () => {
    it('throws OBJECT_LOCKED from inside an update, which then commits, and deletes nothing', async () => {
      const { root, object } = await existingObject();

      const updated = await object.update(DETAILS, async (draft) => {
        await writeB(draft);
        await assertRefused(root, ID, 'OBJECT_LOCKED');
      });

      await assertHolds(root, updated, { 'a.txt': 'a', 'b.txt': 'b' });
      assertNoWorkspace(root);
    });

    it('says when the lock was taken, without claiming an update', async () => {
      const { root } = await existingObject();
      await lockObject(root, ID, new Date('2026-01-02T03:04:05.000Z'));

      await assert.rejects(root.purge(ID), (error: { code?: string; lockedAt?: Date; message?: string }) => {
        assert.strictEqual(error.code, 'OBJECT_LOCKED');
        assert.strictEqual(error.lockedAt?.toISOString(), '2026-01-02T03:04:05.000Z');
        assert.doesNotMatch(error.message ?? '', /updating/);
        return true;
      });
    });

    it('throws OBJECT_LOCKED for an object that is being created', async () => {
      const root = await newRoot();

      const created = await root.create(ID, DETAILS, async (draft) => {
        await draft.write('a.txt', 'a');
        await assertRefused(root, ID, 'OBJECT_LOCKED');
      });

      await assertHolds(root, created, { 'a.txt': 'a' });
    });

    it('is refused after an update died, until the object is recovered, and then leaves nothing behind', async () => {
      const { root, objectRoot, workspace } = await existingObject();
      await lockObject(root, ID);
      await writeFiles(path.join(workspace, 'v2', 'content'), { 'half-written.txt': 'x' });
      await assertRefused(root, ID, 'OBJECT_LOCKED');

      await recover(root, ID);
      await root.purge(ID);

      assert.ok(!fs.existsSync(objectRoot));
      assertNoWorkspace(root);
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
      const recreated = await createObject(root, ID, { 'new.txt': 'new' });
      await assertHolds(root, await recreated.update(DETAILS, writeC), { 'new.txt': 'new', 'c.txt': 'c' });
    });
  });

  describe('of something that is not the object', () => {
    it('throws OBJECT_NOT_FOUND for an id with no object', async () => {
      const root = await newRoot();

      await assertRefused(root, ID, 'OBJECT_NOT_FOUND');
      assertNoWorkspace(root);
    });

    it('throws OBJECT_NOT_FOUND for an id whose path is too long for the file system', async () => {
      const root = await newRoot(NESTED);

      await assertRefused(root, Array(20).fill('x'.repeat(250)).join('/'), 'OBJECT_NOT_FOUND');
    });

    it('throws OBJECT_NOT_FOUND for an id with a segment too long to be the name of a directory', async () => {
      const root = await newRoot(NESTED);

      await assertRefused(root, 'x'.repeat(300), 'OBJECT_NOT_FOUND');
    });

    it('throws OBJECT_NOT_FOUND for an empty directory where the object would be, and keeps it', async () => {
      const root = await newRoot();
      await fs.promises.mkdir(path.join(root.path, 'empty'));

      await assertRefused(root, 'empty', 'OBJECT_NOT_FOUND');
    });

    it('throws OBJECT_ROOT_CONFLICT for a directory with no object declaration', async () => {
      const root = await newRoot();
      await writeFiles(path.join(root.path, 'not-an-object'), { 'stray.txt': 'keep me' });

      await assertRefused(root, 'not-an-object', 'OBJECT_ROOT_CONFLICT');
    });

    it('throws OBJECT_ROOT_CONFLICT for a directory with no object declaration, leaving what is in the workspace for it alone', async () => {
      const root = await newRoot();
      await writeFiles(path.join(root.path, 'not-an-object'), { 'stray.txt': 'stray' });
      await writeFiles(path.join(workspaceOf(root), 'not-an-object', 'v1'), { 'leftover.txt': 'keep me' });

      await assertRefused(root, 'not-an-object', 'OBJECT_ROOT_CONFLICT');
    });

    it('throws OBJECT_ROOT_CONFLICT for a file where the object would be', async () => {
      const root = await newRoot();
      await writeFiles(root.path, { 'stray.txt': 'keep me' });

      await assertRefused(root, 'stray.txt', 'OBJECT_ROOT_CONFLICT');
    });

    it('throws OBJECT_ROOT_CONFLICT for a place below a file', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      await writeFiles(root.path, { 'a-file': 'keep me' });

      await assertRefused(root, 'a-file/inner', 'OBJECT_ROOT_CONFLICT');
    });

    it('throws INVALID_OBJECT with E060 for an object whose sidecar is that of its previous version, though purge holds the lock', async () => {
      const { root, object, objectRoot } = await existingObject();
      const sidecar = path.join(objectRoot, 'inventory.json.sha512');
      const previous = await fs.promises.readFile(sidecar);
      await object.update(DETAILS, writeB);
      await fs.promises.writeFile(sidecar, previous);

      await assertRefused(root, ID, 'INVALID_OBJECT', 'E060');
    });

    it('throws INVALID_OBJECT for a directory whose object declaration has the wrong contents', async () => {
      const root = await newRoot();
      await writeFiles(path.join(root.path, 'bad-declaration'), { '0=ocfl_object_1.1': 'wrong\n' });

      await assertRefused(root, 'bad-declaration', 'INVALID_OBJECT');
    });

    it('throws INVALID_OBJECT for an object whose declaration has been damaged', async () => {
      const { root, objectRoot } = await existingObject();
      await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'wrong\n' });

      await assertRefused(root, ID, 'INVALID_OBJECT', 'E007');
    });

    it('throws INVALID_OBJECT for an object with no inventory to confirm its id', async () => {
      const root = await newRoot();
      await writeFiles(path.join(root.path, 'no-inventory'), DECLARATION);

      await assertRefused(root, 'no-inventory', 'INVALID_OBJECT');
    });

    it('throws INVALID_OBJECT for an object whose inventory cannot be read to confirm its id', async () => {
      const { root, objectRoot } = await existingObject();
      await writeFiles(objectRoot, { 'inventory.json': '{ not json' });

      await assertRefused(root, ID, 'INVALID_OBJECT');
    });

    it('throws INVALID_OBJECT for an object inside an object another tool wrote', async () => {
      const root = await newRoot(NESTED);
      await createObject(root, 'outer/inner', { 'a.txt': 'a' });
      await createObject(root, 'other', { 'a.txt': 'a' });
      await fs.promises.cp(path.join(root.path, 'other', '__object__'), path.join(root.path, 'outer'), { recursive: true });

      await assertRefused(root, 'outer/inner', 'INVALID_OBJECT', 'E082');
    });

    it('throws OBJECT_ROOT_CONFLICT for an id the layout maps to the directory of another object', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, omitScheme: true });
      await createObject(root, 'https://example.org/object', { 'a.txt': 'a' });
      await writeFiles(path.join(workspaceOf(root), 'example.org', 'object', 'v2', 'content'), { 'half-written.txt': 'keep me' });

      await assertRefused(root, 'http://example.org/object', 'OBJECT_ROOT_CONFLICT');
    });

    it('throws OBJECT_NOT_FOUND for an id whose .. segment would reach the directory of another object', async () => {
      const root = await newRoot(NESTED);
      await createObject(root, 'other', { 'a.txt': 'a' });

      await assertRefused(root, 'mistake/../other', 'OBJECT_NOT_FOUND');
    });

    for (const [where, id] of [
      ['the storage root itself', '.'],
      ['a directory above the storage root', '..'],
    ] as const) {
      it(`throws OBJECT_NOT_FOUND for an id the layout maps to ${where}`, async () => {
        const parent = path.join(temp.dir, `parent-of-${id.length}`);
        const root = await createStorageRoot(path.join(parent, 'storage'), { layout: { extensionName: '0002-flat-direct-storage-layout' } });
        await writeFiles(path.join(root.path, id), DECLARATION);
        const before = await snapshot(parent);

        await assert.rejects(root.purge(id), ocflError('OBJECT_NOT_FOUND'));

        assert.deepStrictEqual(await snapshot(parent), before);
      });
    }

    it('throws OBJECT_NOT_FOUND for an object in the extensions directory', async () => {
      const root = await newRoot(NESTED);
      const donor = await newRoot(NESTED);
      await createObject(donor, 'an-extension', { 'a.txt': 'a' });
      await fs.promises.cp(path.join(donor.path, 'an-extension'), path.join(root.path, 'extensions', 'an-extension'), { recursive: true });

      await assertRefused(root, 'extensions/an-extension', 'OBJECT_NOT_FOUND');
    });

    it("throws OBJECT_NOT_FOUND whose cause is the layout's ID_INCOMPATIBLE_WITH_LAYOUT", async () => {
      const root = await newRoot(NESTED);

      const error = await rejection(root.purge('mistake/../other'), 'OBJECT_NOT_FOUND');

      assert.ok(ocflError('ID_INCOMPATIBLE_WITH_LAYOUT')(error.cause));
    });

    for (const [what, id] of [
      ['a missing id', undefined],
      ['an empty id', ''],
    ] as const) {
      it(`throws a TypeError for ${what}`, async () => {
        const root = await newRoot();

        await assert.rejects(root.purge(id as string), TypeError);
      });
    }
  });

  describe('when it fails', () => {
    /** Asserts that `purge` rejects with `RECOVERY_NEEDED` caused by an injected `code`, and that the object stays locked */
    async function assertRecoveryNeeded(root: StorageRoot, purge: Promise<void>, code = 'EIO') {
      const error = await rejection(purge, 'RECOVERY_NEEDED');
      assert.strictEqual((error.cause as NodeJS.ErrnoException).code, code);
      await assert.rejects(root.purge(ID), ocflError('OBJECT_LOCKED'));
    }

    it('throws RECOVERY_NEEDED and keeps the lock when a version cannot be deleted; the object can still be opened', async () => {
      const { root, object, objectRoot } = await existingObject();
      await object.update(DETAILS, writeB);

      await withFsFailure('rm', path.join(objectRoot, 'v2'), () => assertRecoveryNeeded(root, root.purge(ID)));

      assert.ok(!fs.existsSync(path.join(objectRoot, 'v1')));
      assert.strictEqual((await root.open(ID)).head.number, 2);
      await recover(root, ID);
      assert.ok(!fs.existsSync(objectRoot));
      assertNoWorkspace(root);
    });

    it('throws RECOVERY_NEEDED and deletes nothing when the object root has become a file since it was checked', async () => {
      const { root, objectRoot, before } = await existingObject();

      await withFsFailure('readdir', objectRoot, () => assertRecoveryNeeded(root, root.purge(ID), 'ENOTDIR'), 'ENOTDIR');

      assert.deepStrictEqual(await snapshot(objectRoot), before);
    });

    it('throws RECOVERY_NEEDED and keeps the lock when the object root cannot be listed, deleting nothing; recover then purges it', async () => {
      const { root, objectRoot, before } = await existingObject();

      await withFsFailure('readdir', objectRoot, () => assertRecoveryNeeded(root, root.purge(ID)));

      assert.deepStrictEqual(await snapshot(objectRoot), before);
      await recover(root, ID);
      assert.ok(!fs.existsSync(objectRoot));
      assertNoWorkspace(root);
    });

    for (const [gone, names] of [
      ['nothing yet', []],
      ['its versions', ['v1']],
      ['its versions and declaration', ['v1', '0=ocfl_object_1.1']],
      ['its versions and root inventory', ['v1', 'inventory.json']],
      ['its versions and sidecar', ['v1', 'inventory.json.sha512']],
      ['everything', ['.']],
    ] as const) {
      it(`is finished by recover after it died having deleted ${gone}`, async () => {
        const { root, objectRoot, lock } = await existingObject();
        await writeFiles(path.dirname(lock), { lock: JSON.stringify({ id: ID, lockedAt: new Date().toISOString(), objectRootExisted: true, removing: true }) });
        for (const name of names) {
          await fs.promises.rm(path.join(objectRoot, name), { recursive: true });
        }

        await recover(root, ID);

        assert.ok(!fs.existsSync(objectRoot));
        assertNoWorkspace(root);
        assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
        await assertHolds(root, await createObject(root, ID, { 'new.txt': 'new' }), { 'new.txt': 'new' });
      });
    }

    it('throws the file system error and deletes nothing when its lock cannot be marked, and releases the lock', async () => {
      const { root, objectRoot, lock, before } = await existingObject();

      await withFsFailure('rename', lock, () => assert.rejects(root.purge(ID), { code: 'EIO' }));

      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assertNoWorkspace(root);
    });

    it('throws RECOVERY_NEEDED when the object is deleted and its lock cannot be released; recover then releases it', async () => {
      const { root, objectRoot, lock } = await existingObject();

      await withFsFailure('rm', lock, () => assertRecoveryNeeded(root, root.purge(ID)));

      assert.ok(!fs.existsSync(objectRoot));
      await recover(root, ID);
      assertNoWorkspace(root);
      await assert.rejects(root.purge(ID), ocflError('OBJECT_NOT_FOUND'));
    });

    it('throws RECOVERY_NEEDED when it is refused and its lock cannot be released, deleting nothing', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, omitScheme: true });
      await createObject(root, 'https://example.org/object', { 'a.txt': 'a' });
      const before = await snapshot(path.join(root.path, 'example.org'));

      const error = await withFsFailure(
        'rm',
        (target) => path.basename(target) === 'lock',
        () => rejection(root.purge('http://example.org/object'), 'RECOVERY_NEEDED'),
      );

      assert.ok(ocflError('OBJECT_ROOT_CONFLICT')(error.cause));
      await assert.rejects(root.unfinishedWrite('https://example.org/object'), ocflError('OBJECT_ROOT_CONFLICT'));
      await recover(root, 'http://example.org/object');
      assert.deepStrictEqual(await snapshot(path.join(root.path, 'example.org')), before);
      assert.strictEqual(await root.unfinishedWrite('https://example.org/object'), undefined);
    });

    it('throws the file system error when the lock cannot be taken, and deletes nothing', async () => {
      const { root, objectRoot, before } = await existingObject();

      await withFsFailure('link', lockOf(root, ID), () => assert.rejects(root.purge(ID), { code: 'EIO' }));

      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assertNoWorkspace(root);
    });
  });

  it('removes a version a dead writer left in the workspace with no lock', async () => {
    const { root, objectRoot, workspace } = await existingObject();
    await writeFiles(path.join(workspace, 'v2', 'content'), { 'half-written.txt': 'x' });

    await root.purge(ID);

    assert.ok(!fs.existsSync(objectRoot));
    assertNoWorkspace(root);
  });
});
