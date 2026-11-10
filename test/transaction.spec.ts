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
