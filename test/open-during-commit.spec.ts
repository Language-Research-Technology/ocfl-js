import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { StorageRoot } from '../src/index.ts';
import { createObject, DETAILS, objectRootOf, placesOf, readInventory, textFiles, useTempRoots } from './helpers/drafts.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { writeFiles, writeInventory } from './helpers/storage-roots.ts';

const SIDECAR = 'inventory.json.sha512';

describe('opening an object while another writer is committing', () => {
  const { newRoot } = useTempRoots('ocfl-open-during-commit-');

  /**
   * An object with versions 1 and 2, left as a commit of version 2 is between replacing the root inventory and replacing its sidecar.
   * @returns The object root, and the sidecar the commit would go on to write
   */
  async function midCommit(root: StorageRoot, id: string) {
    const objectRoot = objectRootOf(root, id);
    const sidecar = path.join(objectRoot, SIDECAR);
    const object = await createObject(root, id, { 'a.txt': 'one' });
    const previous = await fs.promises.readFile(sidecar);
    await object.update(DETAILS, async (draft) => {
      await draft.write('b.txt', 'two');
    });
    const committed = await fs.promises.readFile(sidecar);
    await fs.promises.writeFile(sidecar, previous);
    return { objectRoot, sidecar, committed };
  }

  const assertNewHead = async (root: StorageRoot, id: string) => {
    const object = await root.open(id);
    assert.strictEqual(object.head.number, 2);
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'one', 'b.txt': 'two' });
  };

  it('opens with the new head while the sidecar is still that of the previous version, and once the sidecar is replaced', async () => {
    const root = await newRoot();
    const { sidecar, committed } = await midCommit(root, 'old-sidecar');
    await assertNewHead(root, 'old-sidecar');
    await fs.promises.writeFile(sidecar, committed);
    await assertNewHead(root, 'old-sidecar');
  });

  it('opens with the new head while the sidecar is missing', async () => {
    const root = await newRoot();
    const { sidecar } = await midCommit(root, 'no-sidecar');
    await fs.promises.rm(sidecar);
    await assertNewHead(root, 'no-sidecar');
  });

  it('opens with the old head before the root inventory is replaced', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'before', { 'a.txt': 'one' });
    let during: number | undefined;
    await object.update(DETAILS, async (draft) => {
      await draft.write('b.txt', 'two');
      during = (await root.open('before')).head.number;
    });
    assert.strictEqual(during, 1);
  });

  it('opens a first version whose sidecar is not yet written', async () => {
    const root = await newRoot();
    await createObject(root, 'first', { 'a.txt': 'one' });
    await fs.promises.rm(path.join(objectRootOf(root, 'first'), SIDECAR));
    const object = await root.open('first');
    assert.strictEqual(object.head.number, 1);
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'one' });
  });

  describe('a root inventory that is not the inventory of the head version', () => {
    const tamper = async (objectRoot: string) => {
      const file = path.join(objectRoot, 'inventory.json');
      await fs.promises.writeFile(file, `${await fs.promises.readFile(file, 'utf8')} `);
    };

    it('throws INVALID_OBJECT with E060 when its sidecar does not match', async () => {
      const root = await newRoot();
      const { objectRoot } = await midCommit(root, 'wrong');
      await tamper(objectRoot);
      await assert.rejects(root.open('wrong'), ocflError('INVALID_OBJECT', 'E060'));
    });

    it('throws INVALID_OBJECT with E058 when it has no sidecar', async () => {
      const root = await newRoot();
      const { objectRoot, sidecar } = await midCommit(root, 'missing');
      await fs.promises.rm(sidecar);
      await tamper(objectRoot);
      await assert.rejects(root.open('missing'), ocflError('INVALID_OBJECT', 'E058'));
    });

    it('throws INVALID_OBJECT with E060 when the head version has no inventory', async () => {
      const root = await newRoot();
      const { objectRoot } = await midCommit(root, 'no-head-inventory');
      await fs.promises.rm(path.join(objectRoot, 'v2', 'inventory.json'));
      await assert.rejects(root.open('no-head-inventory'), ocflError('INVALID_OBJECT', 'E060'));
    });

    it('does not look outside the object for the head version', async () => {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, 'escaping');
      await createObject(root, 'escaping', { 'a.txt': 'one' });
      const content = JSON.stringify({ ...(await readInventory(objectRoot)), head: '../outside' });
      await writeInventory(path.join(root.path, 'outside'), content);
      await fs.promises.writeFile(path.join(objectRoot, 'inventory.json'), content);
      await assert.rejects(root.open('escaping'), ocflError('INVALID_OBJECT', 'E060'));
    });
  });

  describe('a head version inventory that is not proven by its own sidecar', () => {
    it('is not accepted when its sidecar is missing', async () => {
      const root = await newRoot();
      const { objectRoot } = await midCommit(root, 'head-no-sidecar');
      await fs.promises.rm(path.join(objectRoot, 'v2', SIDECAR));
      await assert.rejects(root.open('head-no-sidecar'), ocflError('INVALID_OBJECT', 'E060'));
    });

    it('is not accepted when its sidecar is wrong', async () => {
      const root = await newRoot();
      const { objectRoot, sidecar } = await midCommit(root, 'head-wrong-sidecar');
      await fs.promises.rm(sidecar);
      await fs.promises.writeFile(path.join(objectRoot, 'v2', SIDECAR), 'abc inventory.json\n');
      await assert.rejects(root.open('head-wrong-sidecar'), ocflError('INVALID_OBJECT', 'E058'));
    });
  });

  it('reports a partly written root inventory as damage, as a commit replaces it whole', async () => {
    const root = await newRoot();
    const { objectRoot } = await midCommit(root, 'partly-written');
    await fs.promises.writeFile(path.join(objectRoot, 'inventory.json'), '{"id":');
    await assert.rejects(root.open('partly-written'), ocflError('INVALID_OBJECT', 'E033'));
  });

  /** The files of `objectRoot` read while `fn` runs, relative to it, in order */
  async function filesRead(objectRoot: string, fn: () => Promise<unknown>): Promise<string[]> {
    const read: string[] = [];
    const real = fs.promises.readFile;
    const spy = mock.method(fs.promises, 'readFile', (...args: Parameters<typeof real>) => {
      const relative = path.relative(objectRoot, String(args[0]));
      if (!relative.startsWith('..')) {
        read.push(relative);
      }
      return real.apply(fs.promises, args);
    });
    try {
      await fn();
    } finally {
      spy.mock.restore();
    }
    return read;
  }

  it('opens a healthy object without reading the inventory of the head version', async () => {
    const root = await newRoot();
    await createObject(root, 'healthy', { 'a.txt': 'one' });
    const read = await filesRead(objectRootOf(root, 'healthy'), () => root.open('healthy'));
    assert.deepStrictEqual(
      read.filter((file) => file.includes('inventory')),
      ['inventory.json', SIDECAR],
    );
  });

  it('reads each file once and sets no timer, whether the object opens or is damaged', async () => {
    const root = await newRoot();
    const { objectRoot } = await midCommit(root, 'no-retries');
    const expected = ['inventory.json', SIDECAR, path.join('v2', 'inventory.json'), path.join('v2', SIDECAR)];
    const inventoryReads = async (opening: () => Promise<unknown>) =>
      (await filesRead(objectRoot, opening)).filter((file) => file.includes('inventory')).sort();

    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
      assert.deepStrictEqual(await inventoryReads(() => root.open('no-retries')), expected.toSorted());
      await fs.promises.writeFile(path.join(objectRoot, 'v2', SIDECAR), 'abc inventory.json\n');
      assert.deepStrictEqual(await inventoryReads(() => assert.rejects(root.open('no-retries'), ocflError('INVALID_OBJECT', 'E060'))), expected.toSorted());
    } finally {
      mock.timers.reset();
    }
  });

  describe('a writer that finishes after the root inventory is found missing and before the lock is checked', () => {
    afterEach(() => mock.restoreAll());

    /** Runs `finish` as the lock of `id` is first checked */
    function finishingAtLockCheck(root: StorageRoot, id: string, finish: () => Promise<void>) {
      const { lock } = placesOf(root, id);
      const real = fs.promises.stat;
      let finished = false;
      mock.method(fs.promises, 'stat', async (...args: Parameters<typeof real>) => {
        if (!finished && String(args[0]) === lock) {
          finished = true;
          await finish();
        }
        return real.apply(fs.promises, args);
      });
    }

    it('opens an object whose create commits', async () => {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, 'created');
      await createObject(root, 'created', { 'a.txt': 'one' });
      const aside = path.join(root.path, 'extensions', 'aside');
      await fs.promises.mkdir(aside, { recursive: true });
      const inventoryFiles = ['inventory.json', SIDECAR];
      for (const name of inventoryFiles) {
        await fs.promises.rename(path.join(objectRoot, name), path.join(aside, name));
      }
      finishingAtLockCheck(root, 'created', async () => {
        for (const name of inventoryFiles) {
          await fs.promises.rename(path.join(aside, name), path.join(objectRoot, name));
        }
      });

      const object = await root.open('created');

      assert.strictEqual(object.head.number, 1);
      assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'one' });
    });

    it('throws OBJECT_NOT_FOUND for an object whose remove finishes', async () => {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, 'removed');
      await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
      finishingAtLockCheck(root, 'removed', () => fs.promises.rm(objectRoot, { recursive: true, force: true }));

      await assert.rejects(root.open('removed'), ocflError('OBJECT_NOT_FOUND'));
    });
  });
});
