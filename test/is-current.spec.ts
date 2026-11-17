import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { createObject, DETAILS, objectRootOf, useTempRoots, writeB, writeC } from './helpers/drafts.ts';
import { withFsFailure } from './helpers/fs-failures.ts';

describe('telling whether an opened object is still current', () => {
  const temp = useTempRoots('ocfl-is-current-');

  it('is true straight after open(), create() and update()', async () => {
    const root = await temp.newRoot();
    const created = await createObject(root, 'fresh', { 'a.txt': 'a' });
    assert.strictEqual(await created.isCurrent(), true);
    const updated = await created.update(DETAILS, writeB);
    assert.strictEqual(await updated.isCurrent(), true);
    assert.strictEqual(await (await root.open('fresh')).isCurrent(), true);
  });

  it('is true for an object as the listing yields it', async () => {
    const root = await temp.newRoot();
    await createObject(root, 'listed', { 'a.txt': 'a' });
    for await (const entry of root.objects()) {
      assert.ok(entry.status === 'opened');
      assert.strictEqual(await entry.object.isCurrent(), true);
    }
  });

  it('is false once another opened copy of the object commits an update', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'stale', { 'a.txt': 'a' });
    await (await root.open('stale')).update(DETAILS, writeB);
    assert.strictEqual(await object.isCurrent(), false);
  });

  it('is false once the object is removed', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'removed', { 'a.txt': 'a' });
    await root.remove('removed');
    assert.strictEqual(await object.isCurrent(), false);
  });

  it('stays true while another update is paused inside its callback', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'paused', { 'a.txt': 'a' });
    let during: boolean | undefined;
    await (await root.open('paused')).update(DETAILS, async (draft) => {
      await writeC(draft);
      during = await object.isCurrent();
    });
    assert.strictEqual(during, true);
    assert.strictEqual(await object.isCurrent(), false);
  });

  it('is false once inventory.json is rewritten in place with content of the same length and a new modification time', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'rewritten', { 'a.txt': 'a' });
    const inventory = path.join(objectRootOf(root, 'rewritten'), 'inventory.json');
    const content = await fs.promises.readFile(inventory, 'utf8');
    await fs.promises.writeFile(inventory, content.replace('A test version', 'A_test_version'));
    const later = new Date(Date.now() + 60_000);
    await fs.promises.utimes(inventory, later, later);
    assert.strictEqual(await object.isCurrent(), false);
  });

  it('is false when the root inventory was replaced between being opened and being read', async () => {
    const root = await temp.newRoot();
    await createObject(root, 'swapped', { 'a.txt': 'a' });
    const inventory = path.join(objectRootOf(root, 'swapped'), 'inventory.json');
    const real = fs.promises.open;
    let swapped = false;
    const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
      const handle = await real.apply(fs.promises, args);
      if (!swapped && String(args[0]) === inventory) {
        swapped = true;
        await fs.promises.copyFile(inventory, `${inventory}.copy`);
        await fs.promises.rename(`${inventory}.copy`, inventory);
      }
      return handle;
    });
    let object: Awaited<ReturnType<typeof root.open>>;
    try {
      object = await root.open('swapped');
    } finally {
      spy.mock.restore();
    }
    assert.ok(swapped);
    assert.strictEqual(await object.isCurrent(), false);
  });

  it('passes on a file system error other than the root inventory being missing', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'unreadable', { 'a.txt': 'a' });
    const inventory = path.join(objectRootOf(root, 'unreadable'), 'inventory.json');
    await withFsFailure('stat', inventory, () => assert.rejects(object.isCurrent(), { code: 'EACCES' }), 'EACCES');
  });

  it('is false when the object root has become a file', async () => {
    const root = await temp.newRoot();
    const object = await root.create('replaced', DETAILS, writeB);
    await fs.promises.rm(objectRootOf(root, 'replaced'), { recursive: true });
    await fs.promises.writeFile(objectRootOf(root, 'replaced'), 'not a directory');
    assert.strictEqual(await object.isCurrent(), false);
  });
});
