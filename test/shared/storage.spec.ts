import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import ocfl, {
  type OcflLayoutConfig,
  type LegacyOcflObject as OcflObject,
  type OcflStorage,
  type OcflStorageConfig,
  type OcflVersion,
} from '../../src/index.ts';
import { emptyDirectoriesUnder } from '../empty-directories.ts';
import { writeStorageRoot } from '../helpers/storage-roots.ts';
import { testObject } from '../test-object.ts';

const workspaceOf = (root: string) => path.join(root, 'extensions', 'ocfl-js-workspace');

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
      await assert.rejects(storage.has(id), rejected);
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
describe('removing an object', () => {
  const PATH_DIRECT: OcflLayoutConfig = { extensionName: '000N-path-direct-storage-layout' };
  const ID = 'http://example.org/object';
  let tempdir: string;
  let rootCount = 0;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-remove-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
  const createRoot = (layout?: OcflStorageConfig['layout']) => ocfl.storage({ root: path.join(tempdir, `root-${rootCount++}`), layout }).create();
  const createObject = async (storage: OcflStorage, id: string) => {
    const o = storage.object(id);
    await o.update(async (t) => {
      await t.write('test.txt', 'test');
    });
    return o;
  };
  const leaveFailedUpdate = async (o: OcflObject) => {
    const t = (await o.update())!;
    await t.write('half-written.txt', 'x');
  };

  it('deletes the object and the parent directories it leaves empty, keeping the storage root', async () => {
    const storage = await createRoot();
    const o = await createObject(storage, ID);
    const [topLevelDir] = path.relative(storage.root, o.root).split(path.sep);
    await storage.remove(ID);
    assert.strictEqual(await storage.has(ID), false);
    assert.strictEqual(fs.existsSync(path.join(storage.root, topLevelDir!)), false);
    assert.strictEqual(fs.existsSync(path.join(storage.root, '0=ocfl_1.1')), true);
    await storage.load();
  });

  it('keeps sibling objects and the parent directories they share in a multi-level layout', async () => {
    const storage = await createRoot(PATH_DIRECT);
    const removed = await createObject(storage, 'collection/nested/removed');
    const sibling = await createObject(storage, 'collection/sibling');
    await storage.remove('collection/nested/removed');
    assert.strictEqual(fs.existsSync(removed.root), false);
    assert.strictEqual(fs.existsSync(path.join(storage.root, 'collection', 'nested')), false);
    const reloaded = storage.object('collection/sibling');
    await reloaded.load();
    assert.strictEqual(reloaded.root, sibling.root);
    assert.strictEqual(await reloaded.getFile('test.txt')?.text(), 'test');
  });

  it('succeeds when a parent directory left empty cannot be removed', { skip: process.getuid?.() === 0 }, async () => {
    const storage = await createRoot(PATH_DIRECT);
    const o = await createObject(storage, 'collection/nested/removed');
    const leftover = path.dirname(o.root);
    const readOnly = path.dirname(leftover);
    await fs.promises.chmod(readOnly, 0o555);
    try {
      await storage.remove('collection/nested/removed');
    } finally {
      await fs.promises.chmod(readOnly, 0o755);
    }
    assert.strictEqual(fs.existsSync(o.root), false);
    assert.strictEqual(fs.existsSync(leftover), true);
  });

  it('clears a version a failed update left in the workspace, leaving no empty directories, so a recreated object can be updated', async () => {
    const storage = await createRoot();
    const o = await createObject(storage, ID);
    await leaveFailedUpdate(o);
    await storage.remove(ID);
    assert.strictEqual(fs.existsSync(workspaceOf(storage.root)), false);
    assert.deepStrictEqual(await emptyDirectoriesUnder(storage.root), []);
    const recreated = await createObject(storage, ID);
    await recreated.update(async (t) => t.write('a.txt', 'a'));
    await recreated.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual((await recreated.getInventory())?.head, 'v3');
  });

  it("deletes the workspace parents it leaves empty, keeping a sibling's workspace", async () => {
    const storage = await createRoot(PATH_DIRECT);
    const removed = await createObject(storage, 'collection/nested/removed');
    const sibling = await createObject(storage, 'collection/sibling');
    await leaveFailedUpdate(removed);
    await leaveFailedUpdate(sibling);
    await storage.remove('collection/nested/removed');
    assert.strictEqual(fs.existsSync(removed._workspace), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceOf(storage.root), 'collection', 'nested')), false);
    assert.strictEqual(fs.existsSync(path.join(sibling._workspace, 'v2', 'content', 'half-written.txt')), true);
  });

  it('leaves the workspace untouched when a check fails and nothing is deleted', async () => {
    const storage = await createRoot({ ...PATH_DIRECT, omitScheme: true });
    const other = await createObject(storage, 'https://example.org/object');
    await leaveFailedUpdate(other);
    await assert.rejects(storage.remove('http://example.org/object'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(path.join(other._workspace, 'v2', 'content', 'half-written.txt')), true);
  });

  it('leaves the workspace untouched when the directory has no OCFL object declaration', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    await fs.promises.mkdir(path.join(storage.root, 'not-an-object'));
    await fs.promises.writeFile(path.join(storage.root, 'not-an-object', 'stray.txt'), 'stray');
    const leftover = path.join(workspaceOf(storage.root), 'not-an-object', 'v1', 'leftover.txt');
    await fs.promises.mkdir(path.dirname(leftover), { recursive: true });
    await fs.promises.writeFile(leftover, 'keep me');
    await assert.rejects(storage.remove('not-an-object'), { code: 'NOT_AN_OBJECT' });
    assert.strictEqual(await fs.promises.readFile(leftover, 'utf8'), 'keep me');
  });

  it('throws ObjectNotFoundError for an object that does not exist', async () => {
    const storage = await createRoot();
    await assert.rejects(storage.remove(ID), { name: 'ObjectNotFoundError', code: 'OBJECT_NOT_FOUND' });
  });

  it('throws ObjectNotFoundError for an empty directory at the object root', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    await fs.promises.mkdir(path.join(storage.root, 'empty'));
    await assert.rejects(storage.remove('empty'), { name: 'ObjectNotFoundError', code: 'OBJECT_NOT_FOUND' });
  });

  it('deletes nothing when the directory has no OCFL object declaration', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    const stray = path.join(storage.root, 'not-an-object', 'stray.txt');
    await fs.promises.mkdir(path.dirname(stray));
    await fs.promises.writeFile(stray, 'keep me');
    await assert.rejects(storage.remove('not-an-object'), { name: 'OcflError', code: 'NOT_AN_OBJECT' });
    assert.strictEqual(await fs.promises.readFile(stray, 'utf8'), 'keep me');
  });

  it('deletes nothing when the object root is a file', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    const stray = path.join(storage.root, 'stray.txt');
    await fs.promises.writeFile(stray, 'keep me');
    await assert.rejects(storage.remove('stray.txt'), { name: 'OcflError', code: 'NOT_AN_OBJECT' });
    assert.strictEqual(await fs.promises.readFile(stray, 'utf8'), 'keep me');
  });

  it('deletes nothing when the object declaration has the wrong contents', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    const declaration = path.join(storage.root, 'bad-declaration', '0=ocfl_object_1.1');
    await fs.promises.mkdir(path.dirname(declaration));
    await fs.promises.writeFile(declaration, 'wrong\n');
    await assert.rejects(storage.remove('bad-declaration'), { code: 'E007' });
    assert.strictEqual(fs.existsSync(declaration), true);
  });

  for (const [where, id, declared] of [
    ['the storage root itself', '.', '.'],
    ['a directory above the storage root', '..', '..'],
  ] as const) {
    it(`deletes nothing when the layout maps the id to ${where}`, async () => {
      const parent = path.join(tempdir, `root-${rootCount++}`);
      const storage = await ocfl.storage({ root: path.join(parent, 'storage'), layout: '0002-flat-direct-storage-layout' }).create();
      await fs.promises.writeFile(path.join(storage.root, declared, '0=ocfl_object_1.1'), 'ocfl_object_1.1\n');
      await assert.rejects(storage.remove(id), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
      assert.strictEqual(fs.existsSync(path.join(storage.root, '0=ocfl_1.1')), true);
    });
  }

  it('deletes nothing when the id normalises to a different object', async () => {
    const storage = await createRoot(PATH_DIRECT);
    const other = await createObject(storage, 'other');
    await assert.rejects(storage.remove('mistake/../other'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(path.join(other.root, 'inventory.json')), true);
  });

  it('deletes nothing when the layout maps the id to the same path as another object', async () => {
    const storage = await createRoot({ ...PATH_DIRECT, omitScheme: true });
    const other = await createObject(storage, 'https://example.org/object');
    await assert.rejects(storage.remove('http://example.org/object'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(path.join(other.root, 'inventory.json')), true);
  });

  it('deletes nothing when the object has no inventory to confirm its id', async () => {
    const storage = await createRoot('0002-flat-direct-storage-layout');
    const declaration = path.join(storage.root, 'no-inventory', '0=ocfl_object_1.1');
    await fs.promises.mkdir(path.dirname(declaration));
    await fs.promises.writeFile(declaration, 'ocfl_object_1.1\n');
    await assert.rejects(storage.remove('no-inventory'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(declaration), true);
  });

  it('deletes nothing when the object is nested inside another object', async () => {
    const layout = { ...PATH_DIRECT, suffix: '' };
    const storage = await createRoot(layout);
    await createObject(storage, 'outer');
    const donor = await createRoot(layout);
    const nested = await createObject(donor, 'outer/inner');
    const target = path.join(storage.root, 'outer', 'inner');
    await fs.promises.cp(nested.root, target, { recursive: true });
    await assert.rejects(storage.remove('outer/inner'), { code: 'E082' });
    assert.strictEqual(fs.existsSync(path.join(target, 'inventory.json')), true);
  });

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

  it('deletes nothing in the storage root extensions directory', async () => {
    const layout = { ...PATH_DIRECT, suffix: '' };
    const storage = await createRoot(layout);
    const target = path.join(storage.root, 'extensions', 'an-extension');
    await testObject({ id: 'extensions/an-extension', root: target }).update(async (t) => t.write('test.txt', 'test'));
    await assert.rejects(storage.remove('extensions/an-extension'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(path.join(target, 'inventory.json')), true);
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
    const lock = path.join(o._workspace, 'lock');
    const realOpen = fs.promises.open;
    let raced = false;
    const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
      if (!raced && String(args[0]) === lock) {
        raced = true;
        await fs.promises.rm(path.join(storage.root, 'extensions'), { recursive: true });
      }
      return realOpen.apply(fs.promises, args);
    });
    try {
      await o.update(async (t) => t.write('a.txt', 'a'));
    } finally {
      spy.mock.restore();
    }
    assert.ok(raced);
    assert.strictEqual(await o.getFile('a.txt')!.text(), 'a');
  });

  it('reports any other failure to take the lock, leaving nothing behind', async () => {
    const storage = await ocfl.storage({ root: path.join(tempdir, 'lock-fails') }).create();
    const o = storage.object('object-1');
    const lock = path.join(o._workspace, 'lock');
    const realOpen = fs.promises.open;
    const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
      if (String(args[0]) === lock) {
        throw Object.assign(new Error('injected failure'), { code: 'EACCES' });
      }
      return realOpen.apply(fs.promises, args);
    });
    try {
      await assert.rejects(
        o.update(async (t) => t.write('a.txt', 'a')),
        { code: 'EACCES' },
      );
    } finally {
      spy.mock.restore();
    }
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
