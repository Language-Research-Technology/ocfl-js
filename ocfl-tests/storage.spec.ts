// throw error if workspace is the same as root or a subdirectory of root

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { OcflError, OcflStorage, OcflVersion } from '@ocfl/ocfl';
import { OcflDigest, OcflStorageLayout } from '@ocfl/ocfl';
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
    it('lists every object when iterated', async () => {
      const objarr = [];
      for await (const o of repo) {
        objarr.push(o);
      }
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
  describe('OCFL spec text', () => {
    const resources = path.join(import.meta.dirname, '../ocfl/resources');
    const specFiles = async (root: string) => (await fs.promises.readdir(root)).filter((f) => /^ocfl_\d/.test(f));
    let tempdir: string;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-spec-text-'));
    });
    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });

    for (const [ocflVersion, file] of [
      ['1.1', 'ocfl_1.1.md'],
      ['1.0', 'ocfl_1.0.txt'],
    ] as const) {
      it(`writes ${file} to a ${ocflVersion} root when asked`, async () => {
        const root = path.join(tempdir, `with-${ocflVersion}`);
        await ocfl.storage({ root, ocflVersion }).create({ ocflSpecText: true });
        assert.deepStrictEqual(await fs.promises.readFile(path.join(root, file)), await fs.promises.readFile(path.join(resources, file)));
        assert.deepStrictEqual(await specFiles(root), [file]);
      });
    }

    it('writes no spec file by default', async () => {
      const root = path.join(tempdir, 'default');
      await ocfl.storage({ root }).create();
      assert.deepStrictEqual(await specFiles(root), []);
    });

    it('writes no spec file when ocflSpecText is false', async () => {
      const root = path.join(tempdir, 'disabled');
      await ocfl.storage({ root }).create({ ocflSpecText: false });
      assert.deepStrictEqual(await specFiles(root), []);
    });

    it('does not add a spec file when loading an existing root', async () => {
      const root = path.join(tempdir, 'loaded');
      await ocfl.storage({ root }).create();
      await ocfl.storage({ root }).load();
      assert.deepStrictEqual(await specFiles(root), []);
    });

    for (const ocflVersion of ['1.1', '1.0'] as const) {
      it(`ignores the spec file when loading and using a ${ocflVersion} root`, async () => {
        const root = path.join(tempdir, `usable-${ocflVersion}`);
        await ocfl.storage({ root, ocflVersion }).create({ ocflSpecText: true });
        const storage = await ocfl.storage({ root }).load();
        assert.strictEqual(storage.ocflVersion, ocflVersion);
        const created = storage.object('http://example.org/spec-text');
        await created.update(async (t) => {
          await t.write('test.txt', 'test');
        });
        const roots = [];
        for await (const o of storage) {
          await o.load();
          roots.push(o.root);
        }
        assert.deepStrictEqual(roots, [created.root]);
      });
    }
  });
  describe('configured layout of a loaded storage root', () => {
    const HASHED = '0004-hashed-n-tuple-storage-layout';
    const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    let tempdir: string;
    let rootCount = 0;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-layout-'));
    });
    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
    const createRoot = async ({ layoutFile, extensionConfig }: { layoutFile?: string; extensionConfig?: object } = {}) => {
      const root = path.join(tempdir, `root-${rootCount++}`);
      await fs.promises.mkdir(root);
      await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
      if (layoutFile !== undefined) {
        await fs.promises.writeFile(path.join(root, 'ocfl_layout.json'), layoutFile);
      }
      if (extensionConfig) {
        await fs.promises.mkdir(path.join(root, 'extensions', HASHED), { recursive: true });
        await fs.promises.writeFile(path.join(root, 'extensions', HASHED, 'config.json'), JSON.stringify(extensionConfig));
      }
      return root;
    };
    const declaring = (extension: string) => JSON.stringify({ extension });

    it('keeps the configured layout when the root has no ocfl_layout.json', async () => {
      const root = await createRoot();
      const storage = ocfl.storage({ root, layout: 'FlatDirectStorageLayout' });
      assert.strictEqual(storage.objectRoot('abc'), 'abc');
      await storage.load();
      assert.strictEqual(storage.objectRoot('abc'), 'abc');
    });

    for (const [problem, layoutFile] of [
      ['is not JSON', 'not json'],
      ['is empty', ''],
      ['has a non-object root', 'null'],
      ['has no extension', '{}'],
      ['has a non-string extension', '{"extension":5}'],
    ] as const) {
      it(`rejects a configured layout when ocfl_layout.json ${problem}`, async () => {
        const root = await createRoot({ layoutFile });
        await assert.rejects(ocfl.storage({ root, layout: 'FlatDirectStorageLayout' }).load(), { code: 'E070', path: path.join(root, 'ocfl_layout.json') });
      });
    }

    it('still loads a root with an unparsable ocfl_layout.json when no layout is configured', async () => {
      const root = await createRoot({ layoutFile: 'not json' });
      const storage = await ocfl.storage({ root }).load();
      assert.throws(() => storage.objectRoot('abc'), /No layout defined/);
    });

    it('reads a root naming an unsupported extension with a custom layout instance', async () => {
      class UppercaseLayout extends OcflStorageLayout {
        map(id: string) {
          return id.toUpperCase();
        }
      }
      const root = await createRoot({ layoutFile: declaring('9999-unimplemented-layout') });
      const storage = await ocfl.storage({ root, layout: new UppercaseLayout() }).load();
      assert.strictEqual(storage.objectRoot('abc'), 'ABC');
      assert.strictEqual(storage.object('abc').root, path.join(root, 'ABC'));
    });

    it('rejects a configured layout that differs from the supported layout the root declares, naming both', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED) });
      await assert.rejects(ocfl.storage({ root, layout: 'FlatDirectStorageLayout' }).load(), (error: OcflError) => {
        assert.strictEqual(error.code, 'LAYOUT_MISMATCH');
        assert.match(error.message, /0002-flat-direct-storage-layout/);
        assert.match(error.message, /0004-hashed-n-tuple-storage-layout/);
        return true;
      });
    });

    it('reports a differing layout by name even when the root extension config is invalid', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { digestAlgorithm: 'not-a-digest' } });
      await assert.rejects(ocfl.storage({ root, layout: 'FlatDirectStorageLayout' }).load(), { code: 'LAYOUT_MISMATCH' });
    });

    it('keeps a configured layout matching the name and parameters the root declares', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 2, numberOfTuples: 3 } });
      const storage = await ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 2 } }).load();
      assert.strictEqual(storage.objectRoot('abc'), path.join('ba', '78', '16', ABC_SHA256));
    });

    it('keeps the configured instance when it matches the layout the root declares', async () => {
      class CustomisedHashedLayout extends ocfl.StorageLayout.HashedNTupleStorageLayout {
        map() {
          return 'customised';
        }
      }
      const root = await createRoot({ layoutFile: declaring(HASHED) });
      const storage = await ocfl.storage({ root, layout: new CustomisedHashedLayout() }).load();
      assert.strictEqual(storage.objectRoot('abc'), 'customised');
    });

    it('rejects a configured layout whose parameters differ from the root extension config, naming them', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, numberOfTuples: 2 } });
      await assert.rejects(ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 2 } }).load(), (error: OcflError) => {
        assert.strictEqual(error.code, 'LAYOUT_MISMATCH');
        assert.match(error.message, /configured tupleSize: 2, root tupleSize: 3/);
        assert.match(error.message, /configured numberOfTuples: 3, root numberOfTuples: 2/);
        assert.doesNotMatch(error.message, /digestAlgorithm|extensionName/);
        return true;
      });
    });

    it('compares against the defaults when the root has no extension config', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED) });
      await assert.rejects(ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 2 } }).load(), {
        code: 'LAYOUT_MISMATCH',
      });
    });

    it('treats a configured parameter set to its default as matching a root config that omits it', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED } });
      await ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 3 } }).load();
    });

    it('treats a root parameter set to its default as matching a configured layout that omits it', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 3 } });
      await ocfl.storage({ root, layout: HASHED }).load();
    });

    it('compares a configured layout with ocfl_layout.json, not the extensionName in the extension config', async () => {
      const staleName = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: 'no-such-layout' } });
      await assert.rejects(ocfl.storage({ root: staleName, layout: 'FlatDirectStorageLayout' }).load(), { code: 'LAYOUT_MISMATCH' });

      const otherName = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: '0002-flat-direct-storage-layout' } });
      await ocfl.storage({ root: otherName, layout: HASHED }).load();
    });

    it('reads a root naming a registered layout that has no map() with a custom layout', async () => {
      class UppercaseLayout extends OcflStorageLayout {
        map(id: string) {
          return id.toUpperCase();
        }
      }
      const root = await createRoot({ layoutFile: declaring('0006-flat-omit-prefix-storage-layout') });
      const storage = await ocfl.storage({ root, layout: new UppercaseLayout() }).load();
      assert.strictEqual(storage.objectRoot('abc'), 'ABC');
    });

    it('loads a root with the configured RegExp parameter that created it', async () => {
      const root = path.join(tempdir, `root-${rootCount++}`);
      const layout = { extensionName: '000N-path-direct-storage-layout', replace: [[/x/g, 'y']] };
      await ocfl.createStorage({ root, layout });
      const storage = await ocfl.storage({ root, layout }).load();
      assert.strictEqual(storage.objectRoot('xa'), path.join('ya', '__object__'));
    });

    it('ignores a parameter that only a configured subclass defines', async () => {
      class SaltedHashedLayout extends ocfl.StorageLayout.HashedNTupleStorageLayout {
        constructor() {
          super();
          (this.parameters as unknown as { salt: string }).salt = 'x';
        }
      }
      const root = await createRoot({ layoutFile: declaring(HASHED) });
      await ocfl.storage({ root, layout: new SaltedHashedLayout() }).load();
    });

    it('initialises the digest algorithm of a configured layout', async () => {
      const algorithm = 'test-configured-layout-digest';
      OcflDigest.registerHasherFactory(algorithm, async () => {
        const hasher: unknown = { digestSize: 1, init: () => hasher, update: () => hasher, digest: () => 'digested' };
        return hasher as never;
      });
      class DigestLayout extends OcflStorageLayout<{ digestAlgorithm: string }> {
        constructor() {
          super(undefined, { digestAlgorithm: algorithm });
        }
        map(id: string) {
          return OcflDigest.digestSync(algorithm, id);
        }
      }
      const root = await createRoot();
      const storage = ocfl.storage({ root, layout: new DigestLayout() });
      assert.throws(() => storage.objectRoot('abc'), /not initialized/);
      await storage.load();
      assert.strictEqual(storage.objectRoot('abc'), 'digested');
    });

    it('uses the layout and extension config of the root when no layout is configured', async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 2 } });
      const storage = await ocfl.storage({ root }).load();
      assert.strictEqual(storage.objectRoot('abc'), path.join('ba', '78', '16', ABC_SHA256));
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
