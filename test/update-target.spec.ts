import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OcflObjectInventory } from '../src/inventory.ts';
import { updateTarget } from '../src/storage-root.ts';
import { OcflObjectTransaction, type UpdateTarget } from '../src/transaction.ts';
import { writeFiles } from './helpers/storage-roots.ts';
import { DIGESTS_OF_ABC } from './shared/digests-of-abc.ts';

describe('OcflObjectTransaction driven from an update target', () => {
  let storageRoot: string;
  let target: UpdateTarget;

  const firstVersion = () =>
    OcflObjectInventory.newVersion({ id: 'an-object', digestAlgorithm: 'sha512', type: 'https://ocfl.io/1.0/spec/#inventory', contentDirectory: 'content' });

  beforeEach(async () => {
    storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-update-target-'));
    target = {
      root: path.join(storageRoot, 'objects', 'an-object'),
      workspace: path.join(storageRoot, 'workspace', 'an-object'),
      storageRoot,
      ocflVersion: '1.0',
    };
  });
  afterEach(async () => {
    await fs.promises.rm(storageRoot, { recursive: true, force: true });
  });

  it('commits a version to disk and returns the committed inventory', async () => {
    const transaction = await OcflObjectTransaction.create(target, firstVersion());
    await transaction.write('a.txt', 'abc');
    assert.strictEqual(fs.readFileSync(path.join(target.workspace, 'v1', 'content', 'a.txt'), 'utf8'), 'abc');

    const committed = await transaction._commit({ message: 'first' });

    assert.ok(committed);
    assert.strictEqual(committed.head, 'v1');
    assert.strictEqual(committed.version.message, 'first');
    assert.strictEqual(committed.getDigest('a.txt'), DIGESTS_OF_ABC.sha512);
    assert.deepStrictEqual(fs.readdirSync(target.root).sort(), ['0=ocfl_object_1.0', 'inventory.json', 'inventory.json.sha512', 'v1']);
    assert.strictEqual(fs.readFileSync(path.join(target.root, '0=ocfl_object_1.0'), 'utf8'), 'ocfl_object_1.0\n');
    assert.strictEqual(fs.readFileSync(path.join(target.root, 'v1', 'content', 'a.txt'), 'utf8'), 'abc');
    assert.strictEqual(fs.readFileSync(path.join(target.root, 'inventory.json'), 'utf8'), committed.toString());
    assert.strictEqual(fs.readFileSync(path.join(target.root, 'inventory.json.sha512'), 'utf8'), `${committed._digest} inventory.json`);
    assert.deepStrictEqual(fs.readdirSync(storageRoot), ['objects']);
  });

  it('returns nothing from a commit with no changes, and leaves the object at its version', async () => {
    const first = await OcflObjectTransaction.create(target, firstVersion());
    await first.write('a.txt', 'abc');
    const v1 = await first._commit();
    assert.ok(v1);

    const second = await OcflObjectTransaction.create(target, OcflObjectInventory.newVersion(v1));

    assert.strictEqual(await second._commit(), undefined);
    assert.deepStrictEqual(fs.readdirSync(target.root).sort(), ['0=ocfl_object_1.0', 'inventory.json', 'inventory.json.sha512', 'v1']);
    assert.deepStrictEqual(fs.readdirSync(storageRoot), ['objects']);
  });

  it('refuses a root that holds something other than an object', async () => {
    await writeFiles(target.root, { 'stray.txt': 'stray' });
    const transaction = await OcflObjectTransaction.create(target, firstVersion());
    await transaction.write('a.txt', 'abc');

    await assert.rejects(transaction.commit(), { code: 'DIRECTORY_NOT_EMPTY' });
    assert.deepStrictEqual(fs.readdirSync(target.root), ['stray.txt']);
  });
});

describe('updateTarget', () => {
  it("places the object's workspace under the storage root's workspace, at the object's own path", () => {
    assert.deepStrictEqual(updateTarget('/srv/ocfl', '/srv/ocfl/ab/cd/an-object', '1.1'), {
      root: '/srv/ocfl/ab/cd/an-object',
      workspace: '/srv/ocfl/extensions/ocfl-js-workspace/ab/cd/an-object',
      storageRoot: '/srv/ocfl',
      ocflVersion: '1.1',
    });
  });
});
