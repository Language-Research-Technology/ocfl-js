import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import ocfl from '../src/index.ts';
import { failFsMethod, fsError, mountSeparately } from './fs-failures.ts';

describe('OcflObjectTransaction against a temporary directory', () => {
  let dir: string;
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-transaction-'));
    root = path.join(dir, 'root');
    workspace = path.join(dir, 'workspace');
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

  describe('with the workspace on another filesystem', () => {
    const writeA = (object: ReturnType<typeof ocfl.object>) => object.update(async (t) => t.write('a.txt', 'hello'));

    beforeEach(() => {
      mountSeparately(workspace);
    });

    it('commits the version and leaves nothing behind', async () => {
      const object = ocfl.object({ id: 'an-object', root, workspace });

      await writeA(object);

      assert.strictEqual(fs.readFileSync(path.join(root, 'v1', 'content', 'a.txt'), 'utf8'), 'hello');
      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1']);
      assert.strictEqual(fs.existsSync(workspace), false);
    });

    it('leaves no partial version when the copy fails', async () => {
      mock.method(fs.promises, 'cp', async (_from: string | URL, to: string | URL) => {
        await fs.promises.mkdir(String(to), { recursive: true });
        await fs.promises.writeFile(path.join(String(to), 'partial.txt'), 'partial');
        throw fsError('EIO');
      });

      await assert.rejects(writeA(ocfl.object({ id: 'an-object', root, workspace })), { code: 'EIO' });

      assert.strictEqual(fs.existsSync(root), false);
    });

    it('still commits when the workspace copy cannot be removed', async () => {
      failFsMethod('rm', (target) => target.startsWith(workspace + path.sep), 'EBUSY');
      const object = ocfl.object({ id: 'an-object', root, workspace });

      await writeA(object);

      assert.strictEqual(fs.readFileSync(path.join(root, 'v1', 'content', 'a.txt'), 'utf8'), 'hello');
      assert.strictEqual(fs.existsSync(workspace), true);
    });
  });
});
