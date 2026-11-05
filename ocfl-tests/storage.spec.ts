// throw error if workspace is the same as root or a subdirectory of root

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { OcflStorage, OcflVersion } from '@ocfl/ocfl';
import type { Ocfl } from './index.ts';

export default (ocfl: Ocfl) => {
  describe('constructor', () => {
    it('can create new storage', () => {
      let storage: OcflStorage;
      storage = ocfl.storage({ root: '/data/storage-1' });
      assert.equal(storage.root, '/data/storage-1');

      assert.throws(() => {
        storage = ocfl.storage({ root: '/data/storage-1', layout: ocfl.storageLayout('test') });
      });

      assert.throws(() => {
        storage = ocfl.storage({ root: '/data/storage-1', workspace: '/data/storage-1/temp' });
      });
    });
  });
  describe('access existing storage', () => {
    const repo = ocfl.storage({ root: path.join(import.meta.dirname, 'test-data/storage') });
    const objects = [{ root: path.join(repo.root, 'object_1'), id: 'http://example.org/minimal_no_content' }];
    it('can list objects via async iterator', async () => {
      let i = 0;
      for await (const o of repo) {
        assert.strictEqual(o.root, objects[i]!.root);
        assert.strictEqual(o.id, undefined);
        await o.load();
        assert.strictEqual(o.id, objects[i]!.id);
        ++i;
      }
    });
    it('can list objects via objects() method', async () => {
      const objarr = [];
      for await (const o of repo.objects()) {
        objarr.push(o);
      }
      //const objarr = Promise.all(iter);
      assert.strictEqual(objarr.length, 1);
      assert.strictEqual(objarr[0]!.root, objects[0]!.root);
    });
    it('can retrieve object inventory', async () => {
      const o = repo.object({ root: 'object_1' });
      await o.load();
      assert.strictEqual(o.id, objects[0]!.id);
    });
  });
  describe('mutators', () => {
    const datadir = path.join(import.meta.dirname, 'test-data');
    let tempdir: string;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-'));
    });

    it('can create new storage with default layout', async () => {
      const storage = ocfl.storage({ root: path.join(tempdir, 'storage') });
      await storage.create();
      const namaste = await fs.promises.readFile(path.join(storage.root, `0=ocfl_${storage.ocflVersion}`), 'utf8');
      // namaste
      assert.strictEqual(`ocfl_${storage.ocflVersion}\n`, namaste);
    });

    it('can create object in the storage', async () => {
      const storage = ocfl.storage({ root: path.join(tempdir, 'storage') });
      await storage.load();
      const o = storage.object('http://ocfl.io/examples/object-1');
      await o.update(async (t) => {
        await t.write('test.txt', 'test');
      });
      await o.import(path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3'));
      let test = await fs.promises.readFile(path.join(o.root, 'v1', 'content', 'test.txt'), 'utf8');
      assert.strictEqual(test, 'test');
      test = await fs.promises.readFile(path.join(o.root, 'v2', 'content', 'empty2.txt'), 'utf8');
      assert.strictEqual(test, '');
    });
    after(async () => {
      // delete temp dir
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
  describe('OCFL version of a loaded storage root', () => {
    let tempdir: string;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-version-'));
    });
    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
    const createRoot = async (name: string, ocflVersion: OcflVersion) => {
      const root = path.join(tempdir, name);
      await ocfl.storage({ root, ocflVersion }).create();
      return root;
    };

    it('takes the version from a 1.0 root', async () => {
      const root = await createRoot('root-1.0', '1.0');
      const storage = await ocfl.storage({ root }).load();
      assert.strictEqual(storage.ocflVersion, '1.0');
    });

    it('takes the version from a 1.1 root', async () => {
      const root = await createRoot('root-1.1', '1.1');
      const storage = await ocfl.storage({ root }).load();
      assert.strictEqual(storage.ocflVersion, '1.1');
    });

    it('creates objects at the version of a 1.0 root', async () => {
      const root = await createRoot('root-1.0-objects', '1.0');
      const storage = await ocfl.storage({ root }).load();
      const o = storage.object('http://example.org/object-1.0');
      await o.update(async (t) => {
        await t.write('test.txt', 'test');
      });
      assert.strictEqual(await fs.promises.readFile(path.join(o.root, '0=ocfl_object_1.0'), 'utf8'), 'ocfl_object_1.0\n');
      const inventory = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inventory.type, 'https://ocfl.io/1.0/spec/#inventory');
    });

    it('reports E081 when the configured version is later than the root', async () => {
      const root = await createRoot('root-1.0-configured-1.1', '1.0');
      await assert.rejects(ocfl.storage({ root, ocflVersion: '1.1' }).load(), { code: 'E081', path: root });
    });

    it('keeps an earlier configured version on a 1.1 root', async () => {
      const root = await createRoot('root-1.1-configured-1.0', '1.1');
      const storage = await ocfl.storage({ root, ocflVersion: '1.0' }).load();
      assert.strictEqual(storage.ocflVersion, '1.0');
    });
  });
  describe('spec violations', () => {
    let tempdir: string;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-errors-'));
    });

    it('reports E069 when the root conformance declaration is missing', async () => {
      await assert.rejects(ocfl.storage({ root: tempdir }).load(), { code: 'E069', path: tempdir });
    });

    it('reports E080 when the version declaration has the wrong contents', async () => {
      const root = path.join(tempdir, 'bad-namaste');
      await fs.promises.mkdir(root);
      await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'wrong\n');
      await assert.rejects(ocfl.storage({ root }).load(), { code: 'E080', path: root });
    });

    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
  describe('constructor', () => {
    it('can create new storage', () => {});
  });
};
