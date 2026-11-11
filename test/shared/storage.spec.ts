import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl, { type OcflLayoutConfig, type OcflStorage, type OcflStorageConfig, type OcflVersion } from '../../src/index.ts';
import { emptyDirectoriesUnder } from '../empty-directories.ts';
import { beforeOpening, withFsFailure } from '../fs-failures.ts';
import { writeStorageRoot } from '../helpers/storage-roots.ts';

const workspaceOf = (root: string) => path.join(root, 'extensions', 'ocfl-js-workspace');

describe('access existing storage', () => {
  const repo = ocfl.storage({ root: path.join(import.meta.dirname, 'test-data/storage') });
  it('can retrieve object inventory', async () => {
    const o = repo.object({ root: 'object_1' });
    await o.load();
    assert.strictEqual(o.id, 'http://example.org/minimal_no_content');
  });
});
describe('mutators', () => {
  const datadir = path.join(import.meta.dirname, 'test-data');
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-'));
    await ocfl.storage({ root: path.join(tempdir, 'storage') }).create();
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
    await writeStorageRoot(root, ocflVersion);
    return root;
  };

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

  it('opens an existing 1.0 object in a 1.1 root by its path, at the version the object declares', async () => {
    const root = await createRoot('root-1.1-object-1.0', '1.0');
    const written = (await ocfl.storage({ root }).load()).object('http://example.org/object-1.0');
    await written.update(async (t) => t.write('test.txt', 'test'));
    await fs.promises.rm(path.join(root, '0=ocfl_1.0'));
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    const storage = await ocfl.storage({ root }).load();
    const o = storage.object({ root: path.relative(root, written.root) });
    await o.load();
    assert.strictEqual(storage.ocflVersion, '1.1');
    assert.strictEqual(o.ocflVersion, '1.0');
    assert.strictEqual(await o.getFile('test.txt')!.text(), 'test');
  });
});
describe('mapping an object to a path outside its place in the storage root', () => {
  let tempdir: string;
  let rootCount = 0;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-containment-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
  /** A storage root alone in its own parent directory, so that a write outside it shows up as a sibling */
  const createRoot = (layout: OcflStorageConfig['layout']) => {
    const parent = path.join(tempdir, `parent-${rootCount++}`);
    return ocfl.storage({ root: path.join(parent, 'storage'), layout }).create();
  };
  const listing = async (storage: OcflStorage) => ({
    parent: await fs.promises.readdir(path.dirname(storage.root)),
    root: await fs.promises.readdir(storage.root, { recursive: true }),
  });
  const rejected = { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' };

  for (const id of ['../x', 'a/../../x', 'a/./b', 'extensions/foo']) {
    it(`rejects the path-direct id ${id} and writes nothing`, async () => {
      const storage = await createRoot('000N-path-direct-storage-layout');
      const before = await listing(storage);
      assert.throws(() => storage.objectRoot(id), rejected);
      assert.throws(() => storage.object(id), rejected);
      await assert.rejects(async () => storage.object(id).import(import.meta.filename), rejected);
      assert.deepStrictEqual(await listing(storage), before);
    });
  }

  for (const [what, root] of [
    ['outside the storage root', '../x'],
    ['the storage root itself', '.'],
    ['a path resolving to the storage root', 'a/..'],
    ['in the extensions directory', 'extensions/x'],
  ]) {
    it(`rejects an object root ${what} and writes nothing`, async () => {
      const storage = await createRoot('0002-flat-direct-storage-layout');
      const before = await listing(storage);
      assert.throws(() => storage.object({ id: 'x', root }), rejected);
      assert.throws(() => storage.object({ root }), rejected);
      assert.deepStrictEqual(await listing(storage), before);
    });
  }

  it('still accepts an object root inside the storage root', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    const o = storage.object({ id: 'x', root: 'a/b' });
    await o.update(async (t) => t.write('a.txt', 'a'));
    assert.strictEqual(o.root, path.join(storage.root, 'a', 'b'));
  });
});
describe('an object root the storage root cannot hold', () => {
  const PATH_DIRECT: OcflLayoutConfig = { extensionName: '000N-path-direct-storage-layout' };
  let tempdir: string;
  let rootCount = 0;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-object-root-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
  const createRoot = (layout?: OcflStorageConfig['layout']) => ocfl.storage({ root: path.join(tempdir, `root-${rootCount++}`), layout }).create();
  for (const root of ['extensions/ocfl-js-workspace/an-object', 'extensions', 'Extensions/ocfl-js-workspace/an-object', '../outside', '.']) {
    it(`refuses to open an object at ${root}, which can't hold an object in this storage root`, async () => {
      const storage = await createRoot(PATH_DIRECT);
      assert.throws(() => storage.object({ root }), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    });
  }

  it('refuses an id the layout maps into the extensions directory', async () => {
    const storage = await createRoot({ ...PATH_DIRECT, suffix: '' });
    assert.throws(() => storage.object('extensions/ocfl-js-workspace/an-object'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
  });
});
describe('workspace', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-workspace-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
  const layouts: OcflLayoutConfig[] = [{ extensionName: '0002-flat-direct-storage-layout' }, { extensionName: '0004-hashed-n-tuple-storage-layout' }];

  it('ignores a workspace passed by an untyped caller', async () => {
    const scratch = path.join(tempdir, 'scratch');
    const storage = await ocfl.storage({ root: path.join(tempdir, 'ignores'), workspace: scratch } as OcflStorageConfig).create();
    const o = storage.object('object-1');
    await o.update(async (t) => {
      await t.write('a.txt', 'a');
      assert.ok(fs.existsSync(path.join(workspaceOf(storage.root), path.relative(storage.root, o.root), 'v1')));
    });
    assert.ok(!fs.existsSync(scratch));
  });

  it("takes the lock when another update's cleanup removes the empty workspace first", async () => {
    const storage = await ocfl.storage({ root: path.join(tempdir, 'race') }).create();
    const o = storage.object('object-1');
    await beforeOpening(
      path.join(o._workspace, 'lock'),
      () => fs.promises.rm(path.join(storage.root, 'extensions'), { recursive: true }),
      () => o.update(async (t) => t.write('a.txt', 'a')),
    );
    assert.strictEqual(await o.getFile('a.txt')!.text(), 'a');
  });

  it('reports any other failure to take the lock, leaving nothing behind', async () => {
    const storage = await ocfl.storage({ root: path.join(tempdir, 'lock-fails') }).create();
    const o = storage.object('object-1');
    await withFsFailure(
      'open',
      path.join(o._workspace, 'lock'),
      () =>
        assert.rejects(
          o.update(async (t) => t.write('a.txt', 'a')),
          { code: 'EACCES' },
        ),
      'EACCES',
    );
    assert.ok(!fs.existsSync(o.root));
    assert.ok(!fs.existsSync(workspaceOf(storage.root)));
  });

  for (const layout of layouts) {
    it(`assembles a version in extensions/ocfl-js-workspace and leaves no empty directories (${layout.extensionName})`, async () => {
      const storage = await ocfl.storage({ root: path.join(tempdir, `ok-${layout.extensionName}`), layout }).create();
      const o = storage.object('object-1');
      const assembly = path.join(workspaceOf(storage.root), path.relative(storage.root, o.root), 'v1');
      await o.update(async (t) => {
        await t.write('a.txt', 'a');
        assert.ok(fs.existsSync(assembly), `expected ${assembly} during the update`);
      });
      assert.ok(!fs.existsSync(workspaceOf(storage.root)));
      assert.deepStrictEqual(await emptyDirectoriesUnder(storage.root), []);
    });

    it(`leaves no empty directories after a rolled-back update (${layout.extensionName})`, async () => {
      const storage = await ocfl.storage({ root: path.join(tempdir, `rollback-${layout.extensionName}`), layout }).create();
      const o = storage.object('object-1');
      await assert.rejects(
        o.update(async (t) => {
          await t.write('a.txt', 'a');
          throw new Error('abandon');
        }),
        /abandon/,
      );
      assert.ok(!fs.existsSync(workspaceOf(storage.root)));
      assert.deepStrictEqual(await emptyDirectoriesUnder(storage.root), []);
    });
  }
});
