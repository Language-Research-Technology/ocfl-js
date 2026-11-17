import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import type { StorageRoot } from '../src/index.ts';
import { DETAILS, lockObject, lockOf, objectRootOf, useTempRoots, writeB, writeC } from './helpers/drafts.ts';
import { mountSeparately, withFsFailure } from './helpers/fs-failures.ts';
import { rejection } from './helpers/ocfl-error.ts';
import { rewriteInventory } from './helpers/storage-roots.ts';

describe('error messages', () => {
  const temp = useTempRoots('ocfl-messages-');

  /** Asserts that `error` names the object `id`, and no path in the storage root */
  function assertNamesIdOnly(error: Error, root: StorageRoot, id: string) {
    assert.ok(error.message.includes(`<${id}>`), error.message);
    assert.ok(!error.message.includes(root.path), error.message);
  }

  /** Asserts that `error` names the object `id`, and gives `place` */
  function assertNamesIdAnd(error: Error, id: string, place: string) {
    assert.ok(error.message.includes(`<${id}>`), error.message);
    assert.ok(error.message.includes(place), error.message);
  }

  it('OBJECT_EXISTS names the object by its id, not its object root', async () => {
    const root = await temp.newRoot();
    await root.create('item-1', DETAILS, writeB);

    assertNamesIdOnly(await rejection(root.create('item-1', DETAILS, writeB), 'OBJECT_EXISTS'), root, 'item-1');
  });

  it('OBJECT_OUT_OF_DATE names the object by its id after another update', async () => {
    const root = await temp.newRoot();
    const object = await root.create('item-1', DETAILS, writeB);
    await (await root.open('item-1')).update(DETAILS, writeC);

    assertNamesIdOnly(await rejection(object.update(DETAILS, writeC), 'OBJECT_OUT_OF_DATE'), root, 'item-1');
  });

  it('OBJECT_OUT_OF_DATE names the object by its id after a purge', async () => {
    const root = await temp.newRoot();
    const object = await root.create('item-1', DETAILS, writeB);
    await root.purge('item-1');

    assertNamesIdOnly(await rejection(object.update(DETAILS, writeC), 'OBJECT_OUT_OF_DATE'), root, 'item-1');
  });

  it('OBJECT_NOT_FOUND names the object by its id, and not the storage root', async () => {
    const root = await temp.newRoot();

    assertNamesIdOnly(await rejection(root.open('item-1'), 'OBJECT_NOT_FOUND'), root, 'item-1');
  });

  it('OBJECT_LOCKED names the object by its id, and gives its lock', async () => {
    const root = await temp.newRoot();
    await root.create('item-1', DETAILS, writeB);
    await lockObject(root, 'item-1');

    assertNamesIdAnd(await rejection(root.purge('item-1'), 'OBJECT_LOCKED'), 'item-1', lockOf(root, 'item-1'));
  });

  it('RECOVERY_NEEDED from an update names the object by its id, and gives its object root', async () => {
    const root = await temp.newRoot();
    const object = await root.create('item-1', DETAILS, writeB);
    const sidecar = path.join(objectRootOf(root, 'item-1'), 'inventory.json.sha512');

    const error = await withFsFailure('rename', sidecar, () => rejection(object.update(DETAILS, writeC), 'RECOVERY_NEEDED'));

    assertNamesIdAnd(error, 'item-1', objectRootOf(root, 'item-1'));
  });

  it('RECOVERY_NEEDED from a purge names the object by its id, and gives its object root', async () => {
    const root = await temp.newRoot();
    await root.create('item-1', DETAILS, writeB);

    const error = await withFsFailure('rm', path.join(objectRootOf(root, 'item-1'), 'v1'), () => rejection(root.purge('item-1'), 'RECOVERY_NEEDED'));

    assertNamesIdAnd(error, 'item-1', objectRootOf(root, 'item-1'));
  });

  it('CROSS_FILESYSTEM_MOVE names the object by its id, and gives its object root', async () => {
    const root = await temp.newRoot();
    mountSeparately(path.join(root.path, 'extensions'));
    try {
      const error = await rejection(root.create('item-1', DETAILS, writeB), 'CROSS_FILESYSTEM_MOVE');

      assertNamesIdAnd(error, 'item-1', objectRootOf(root, 'item-1'));
    } finally {
      mock.restoreAll();
    }
  });

  it('UNSUPPORTED_FILESYSTEM names the object by its id, and gives its lock', async () => {
    const root = await temp.newRoot();

    const error = await withFsFailure(
      'link',
      () => true,
      () => rejection(root.create('item-1', DETAILS, writeB), 'UNSUPPORTED_FILESYSTEM'),
      'EPERM',
    );

    assertNamesIdAnd(error, 'item-1', lockOf(root, 'item-1'));
  });

  describe('a spec violation', () => {
    it('in an inventory its sidecar confirms names the object by its id, and gives the inventory', async () => {
      const root = await temp.newRoot();
      await root.create('item-1', DETAILS, writeB);
      const objectRoot = objectRootOf(root, 'item-1');
      await rewriteInventory(objectRoot, (inventory) => {
        inventory.head = 'v9';
      });

      const error = await rejection(root.open('item-1'), 'INVALID_OBJECT');

      assert.strictEqual(error.ocflCode, 'E040');
      assert.ok(error.message.includes(`At ${path.join(objectRoot, 'inventory.json')}, in the object <item-1> (`), error.message);
    });

    it("in an inventory its sidecar doesn't confirm gives the inventory, and not the id it names", async () => {
      const root = await temp.newRoot();
      await root.create('item-1', DETAILS, writeB);
      const inventory = path.join(objectRootOf(root, 'item-1'), 'inventory.json');
      await fs.promises.writeFile(`${inventory}.sha512`, `${'0'.repeat(128)}  inventory.json\n`);

      const error = await rejection(root.open('item-1'), 'INVALID_OBJECT');

      assert.strictEqual(error.ocflCode, 'E060');
      assert.ok(error.message.includes(inventory), error.message);
      assert.ok(!error.message.includes('<item-1>'), error.message);
    });

    it('in the object root of an id names the object by that id, and gives the object root', async () => {
      const root = await temp.newRoot();
      await root.create('item-1', DETAILS, writeB);
      const objectRoot = objectRootOf(root, 'item-1');
      await fs.promises.rm(path.join(objectRoot, '0=ocfl_object_1.1'));

      const error = await rejection(root.open('item-1'), 'INVALID_OBJECT');

      assert.strictEqual(error.ocflCode, 'E003');
      assertNamesIdAnd(error, 'item-1', objectRoot);
    });
  });

  it('INVALID_OBJECT for a missing stored file names the object by its id, and gives its object root', async () => {
    const root = await temp.newRoot();
    const object = await root.create('item-1', DETAILS, writeB);
    const objectRoot = objectRootOf(root, 'item-1');
    await fs.promises.rm(path.join(objectRoot, 'v1', 'content', 'b.txt'));

    const error = await rejection(object.head.files.get('b.txt')!.text(), 'INVALID_OBJECT');

    assertNamesIdAnd(error, 'item-1', objectRoot);
  });

  it('draft operations name the object as <id>', async () => {
    const root = await temp.newRoot();
    const object = await root.create('item-1', DETAILS, writeB);
    const messages: string[] = [];

    await object.update(DETAILS, async (draft) => {
      for (const refused of [draft.remove('missing.txt'), draft.rename('missing.txt', 'x.txt'), draft.reinstate('b.txt', 9)]) {
        messages.push((await rejection(refused)).message);
      }
      await writeC(draft);
    });

    for (const message of messages) {
      assert.ok(message.includes('<item-1>') && !message.includes('[item-1]'), message);
    }
  });
});
