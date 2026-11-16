import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DETAILS, lockObject, objectRootOf, useTempRoots, writeB } from './helpers/drafts.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { writeFiles } from './helpers/storage-roots.ts';

describe('testing whether an object exists', () => {
  const temp = useTempRoots('ocfl-has-');

  it('is true for a committed object and false for an absent id', async () => {
    const root = await temp.newRoot();
    await root.create('present', DETAILS, writeB);
    assert.strictEqual(await root.has('present'), true);
    assert.strictEqual(await root.has('absent'), false);
  });

  it('is false for a create paused inside its callback', async () => {
    const root = await temp.newRoot();
    let during: boolean | undefined;
    await root.create('creating', DETAILS, async (draft) => {
      await writeB(draft);
      during = await root.has('creating');
    });
    assert.strictEqual(during, false);
    assert.strictEqual(await root.has('creating'), true);
  });

  it('is true for an object root with a declaration, no inventory and no lock, which open() refuses', async () => {
    const root = await temp.newRoot();
    await root.create('no-inventory', DETAILS, writeB);
    await fs.promises.rm(path.join(objectRootOf(root, 'no-inventory'), 'inventory.json'));
    assert.strictEqual(await root.has('no-inventory'), true);
    await assert.rejects(root.open('no-inventory'), ocflError('INVALID_OBJECT', 'E063'));
  });

  it('is false for an object root with a declaration and no inventory while its lock is held', async () => {
    const root = await temp.newRoot();
    await writeFiles(objectRootOf(root, 'locked'), { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
    await lockObject(root, 'locked');
    assert.strictEqual(await root.has('locked'), false);
  });

  it('is true for a damaged object, without reading its inventory', async () => {
    const root = await temp.newRoot();
    await root.create('damaged', DETAILS, writeB);
    await fs.promises.writeFile(path.join(objectRootOf(root, 'damaged'), 'inventory.json'), 'not json');
    assert.strictEqual(await root.has('damaged'), true);
    await assert.rejects(root.open('damaged'), ocflError('INVALID_OBJECT'));
  });

  it('agrees with create(): true exactly when create() throws OBJECT_EXISTS', async () => {
    const root = await temp.newRoot();
    await root.create('exists', DETAILS, writeB);
    assert.strictEqual(await root.has('exists'), true);
    await assert.rejects(root.create('exists', DETAILS, writeB), ocflError('OBJECT_EXISTS'));
  });

  it('throws TypeError for a missing or empty id', async () => {
    const root = await temp.newRoot();
    await assert.rejects(root.has(''), TypeError);
    await assert.rejects(root.has(undefined as unknown as string), TypeError);
  });

  it("throws ID_INCOMPATIBLE_WITH_LAYOUT for an id the layout can't map", async () => {
    const root = await temp.newRoot();
    await assert.rejects(root.has('..'), ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
  });
});
