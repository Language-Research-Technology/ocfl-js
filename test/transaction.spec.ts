import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import ocfl, { type OcflStorage } from '../src/index.ts';
import { mountSeparately } from './fs-failures.ts';

describe('OcflObjectTransaction against a temporary directory', () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-transaction-'));
    root = path.join(dir, 'root');
  });
  afterEach(async () => {
    mock.restoreAll();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('writes an object through update() and reads the file back', async () => {
    const storage = await ocfl.createStorage({ root });
    await storage.object('an-object').update(async (t) => {
      await t.write('data/a.txt', 'on disk');
    });

    const object = storage.object('an-object');
    await object.load();
    assert.strictEqual(await object.getFile('data/a.txt')?.text(), 'on disk');
    assert.strictEqual(fs.readFileSync(path.join(root, storage.objectRoot('an-object'), 'v1', 'content', 'data', 'a.txt'), 'utf8'), 'on disk');
  });

  describe("the object's cached inventory", () => {
    let storage: OcflStorage;
    beforeEach(async () => {
      storage = await ocfl.createStorage({ root, layout: { extensionName: '0002-flat-direct-storage-layout' } });
    });

    async function objectAtV1() {
      const object = storage.object('an-object');
      await object.update(async (t) => t.write('a.txt', 'a'));
      return object;
    }

    function assertAtV1(inventory: unknown, object: { inventory: unknown }) {
      assert.strictEqual(object.inventory, inventory);
      const inv = object.inventory as { head: string; getDigest(p: string): string | undefined; state: object };
      assert.strictEqual(inv.head, 'v1');
      assert.ok(inv.getDigest('a.txt'));
      assert.strictEqual(inv.getDigest('b.txt'), undefined);
      assert.strictEqual(Object.keys(inv.state).length, 1);
    }

    it('is unchanged by an update whose updater rejects', async () => {
      const object = await objectAtV1();
      const before = object.inventory;
      await assert.rejects(
        object.update(async (t) => {
          await t.write('b.txt', 'b');
          await t.remove('a.txt');
          throw new Error('stop');
        }),
        /stop/,
      );
      assertAtV1(before, object);
    });

    it('is unchanged by a rolled-back transaction', async () => {
      const object = await objectAtV1();
      const before = object.inventory;
      const t = await object.update();
      await t?.write('b.txt', 'b');
      await t?.rename('a.txt', 'c.txt');
      await t?.rollback();
      assertAtV1(before, object);
    });

    it('is unchanged by a commit that fails', async () => {
      const object = await objectAtV1();
      const before = object.inventory;
      mountSeparately(path.join(root, 'extensions'));
      await assert.rejects(
        object.update(async (t) => t.write('b.txt', 'b')),
        { code: 'CROSS_FILESYSTEM_MOVE' },
      );
      assertAtV1(before, object);
    });

    it('shows a committed version, which a later update leaves alone until it commits', async () => {
      const object = await objectAtV1();
      const t = await object.update();
      await t?.write('b.txt', 'b');
      await t?.commit({ message: 'add b' });
      const v2 = object.inventory;
      assert.strictEqual(v2?.head, 'v2');
      assert.strictEqual(v2?.version.message, 'add b');
      assert.ok(v2?.getDigest('b.txt'));
      await assert.rejects(t!.write('c.txt', 'c'));

      const next = await object.update();
      await next?.remove('b.txt');
      await next?.write('c.txt', 'c');
      assert.strictEqual(object.inventory, v2);
      assert.strictEqual(v2?.head, 'v2');
      assert.ok(v2?.getDigest('b.txt'));
      assert.strictEqual(v2?.getDigest('c.txt'), undefined);
      await next?.commit();
      assert.strictEqual(object.inventory?.head, 'v3');
      assert.strictEqual(object.inventory?.getDigest('b.txt'), undefined);
    });

    it('answers lookups after a commit as the inventory read from storage does', async () => {
      const object = storage.object('an-object');
      await object.update(async (t) => {
        await t.write('a.txt', 'a');
        await t.write('dir/b.txt', 'b');
      });
      await object.update(async (t) => {
        await t.rename('dir', 'moved');
        await t.copy('a.txt', 'a-copy.txt');
        await t.write('a.txt', 'changed');
      });
      await object.update(async (t) => {
        await t.remove('a-copy.txt');
        await t.reinstate('a.txt', 'v1');
      });
      const read = storage.object('an-object');
      await read.load();
      const committed = object.inventory;
      assert.notStrictEqual(committed, read.inventory);
      assert.strictEqual(committed?.toString(), read.inventory?.toString());
      for (const version of ['v1', 'v2', 'v3']) {
        assert.deepStrictEqual([...(committed?.files(version) ?? [])], [...(read.inventory?.files(version) ?? [])], version);
        for (const path of ['a.txt', 'a-copy.txt', 'dir/b.txt', 'moved/b.txt']) {
          assert.deepStrictEqual(committed?.getFile(path, version), read.inventory?.getFile(path, version), `${path} in ${version}`);
        }
      }
    });
  });

  describe('with the workspace on another filesystem from the object', () => {
    let storage: OcflStorage;
    beforeEach(async () => {
      storage = await ocfl.createStorage({ root, layout: { extensionName: '0002-flat-direct-storage-layout' } });
    });

    it('fails a new object with CROSS_FILESYSTEM_MOVE and leaves nothing behind', async () => {
      mountSeparately(path.join(root, 'extensions'));

      await assert.rejects(
        storage.object('an-object').update(async (t) => t.write('a.txt', 'hello')),
        { code: 'CROSS_FILESYSTEM_MOVE' },
      );

      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['0=ocfl_1.1', 'ocfl-js-workspace.md', 'ocfl_layout.json']);
    });

    it('leaves an existing object at its previous version', async () => {
      await storage.object('an-object').update(async (t) => t.write('a.txt', 'hello'));
      mountSeparately(path.join(root, 'extensions'));

      await assert.rejects(
        storage.object('an-object').update(async (t) => t.write('b.txt', 'b')),
        { code: 'CROSS_FILESYSTEM_MOVE' },
      );

      mock.restoreAll();
      const object = storage.object('an-object');
      await object.load();
      assert.strictEqual(object.headVersion?.toString(), 'v1');
      assert.deepStrictEqual(fs.readdirSync(object.root).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1']);
      assert.strictEqual(fs.existsSync(path.join(root, 'extensions')), false);
    });
  });
});
