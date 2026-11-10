// throw error if workspace is the same as root or a subdirectory of root

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl, { type OcflError, type OcflLayoutConfig, type OcflStorage, type OcflStorageConfig, type OcflVersion } from '../../src/index.ts';
import { DIGESTS_OF_ABC } from './digests-of-abc.ts';

describe('constructor', () => {
  it('requires a root', () => {
    assert.throws(() => ocfl.storage({ root: '' }), TypeError);
  });

  it('can create new storage', () => {
    let storage: OcflStorage;
    storage = ocfl.storage({ root: '/data/storage-1' });
    assert.equal(storage.root, '/data/storage-1');

    assert.throws(
      () => {
        storage = ocfl.storage({ root: '/data/storage-1', layout: 'test' as never });
      },
      { code: 'UNSUPPORTED_LAYOUT' },
    );

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
  const resources = path.join(import.meta.dirname, '../../resources');
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
  const HASHED = '0004-hashed-n-tuple-storage-layout' as const;
  let tempdir: string;
  let rootCount = 0;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-storage-layout-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
  const createRoot = async ({ layoutFile, extensionConfig }: { layoutFile?: string; extensionConfig?: object | string } = {}) => {
    const root = path.join(tempdir, `root-${rootCount++}`);
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    if (layoutFile !== undefined) {
      await fs.promises.writeFile(path.join(root, 'ocfl_layout.json'), layoutFile);
    }
    if (extensionConfig !== undefined) {
      await fs.promises.mkdir(path.join(root, 'extensions', HASHED), { recursive: true });
      const content = typeof extensionConfig === 'string' ? extensionConfig : JSON.stringify(extensionConfig);
      await fs.promises.writeFile(path.join(root, 'extensions', HASHED, 'config.json'), content);
    }
    return root;
  };
  const declaring = (extension: string) => JSON.stringify({ extension });

  it('keeps the configured layout when the root has no ocfl_layout.json', async () => {
    const root = await createRoot();
    const storage = ocfl.storage({ root, layout: '0002-flat-direct-storage-layout' });
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
      await assert.rejects(ocfl.storage({ root, layout: '0002-flat-direct-storage-layout' }).load(), {
        code: 'E070',
        path: path.join(root, 'ocfl_layout.json'),
      });
    });

    it(`rejects a root whose ocfl_layout.json ${problem} when no layout is configured`, async () => {
      const root = await createRoot({ layoutFile });
      await assert.rejects(ocfl.storage({ root }).load(), { code: 'E070', path: path.join(root, 'ocfl_layout.json') });
    });
  }

  for (const extension of ['0006-flat-omit-prefix-storage-layout', '0007-n-tuple-omit-prefix-storage-layout', '9999-unimplemented-layout', 'constructor']) {
    it(`rejects a root declaring ${extension} with no layout configured`, async () => {
      const root = await createRoot({ layoutFile: declaring(extension) });
      await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT', message: new RegExp(extension) });
    });

    it(`rejects a root declaring ${extension} with a layout configured`, async () => {
      const root = await createRoot({ layoutFile: declaring(extension) });
      await assert.rejects(ocfl.loadStorage({ root, layout: '0002-flat-direct-storage-layout' }), {
        code: 'UNSUPPORTED_LAYOUT',
        message: new RegExp(extension),
      });
    });

    it(`rejects a root declaring ${extension} whose extension config names a built-in layout`, async () => {
      const root = await createRoot({ layoutFile: declaring(extension) });
      await fs.promises.mkdir(path.join(root, 'extensions', extension), { recursive: true });
      await fs.promises.writeFile(
        path.join(root, 'extensions', extension, 'config.json'),
        JSON.stringify({ extensionName: '0002-flat-direct-storage-layout' }),
      );
      await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT', message: new RegExp(extension) });
    });
  }

  it('rejects a root whose ocfl_layout.json extension is empty', async () => {
    const root = await createRoot({ layoutFile: declaring('') });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT' });
    await assert.rejects(ocfl.storage({ root, layout: '0002-flat-direct-storage-layout' }).load(), { code: 'UNSUPPORTED_LAYOUT' });
  });

  it('rejects a root whose ocfl_layout.json extension is a non-string holding a supported name', async () => {
    const root = await createRoot({ layoutFile: JSON.stringify({ extension: ['0002-flat-direct-storage-layout'] }) });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'E070' });
  });

  it('rejects a root whose extension config extensionName is a non-string holding a supported name', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: ['0002-flat-direct-storage-layout'] } });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT' });
  });

  it('rejects a configured layout that differs from the supported layout the root declares, naming both', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED) });
    await assert.rejects(ocfl.storage({ root, layout: '0002-flat-direct-storage-layout' }).load(), (error: OcflError) => {
      assert.strictEqual(error.code, 'LAYOUT_MISMATCH');
      assert.match(error.message, /0002-flat-direct-storage-layout/);
      assert.match(error.message, /0004-hashed-n-tuple-storage-layout/);
      return true;
    });
  });

  it('reports a differing layout by name even when the root extension config is invalid', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { digestAlgorithm: 'not-a-digest' } });
    await assert.rejects(ocfl.storage({ root, layout: '0002-flat-direct-storage-layout' }).load(), { code: 'LAYOUT_MISMATCH' });
  });

  it('keeps a configured layout matching the name and parameters the root declares', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 2, numberOfTuples: 3 } });
    const storage = await ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 2 } }).load();
    assert.strictEqual(storage.objectRoot('abc'), path.join('ba', '78', '16', DIGESTS_OF_ABC.sha256));
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
    await assert.rejects(ocfl.storage({ root: staleName, layout: '0002-flat-direct-storage-layout' }).load(), { code: 'LAYOUT_MISMATCH' });

    const otherName = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: '0002-flat-direct-storage-layout' } });
    await ocfl.storage({ root: otherName, layout: HASHED }).load();
  });

  it('loads a root with the configured RegExp parameter that created it', async () => {
    const root = path.join(tempdir, `root-${rootCount++}`);
    const layout: OcflLayoutConfig = { extensionName: '000N-path-direct-storage-layout', replace: [[/x/g, 'y']] };
    await ocfl.createStorage({ root, layout });
    const storage = await ocfl.storage({ root, layout }).load();
    assert.strictEqual(storage.objectRoot('xa'), path.join('ya', '__object__'));
  });

  for (const [digestAlgorithm, digest] of Object.entries(DIGESTS_OF_ABC)) {
    it(`creates, writes to and reloads a root hashed with ${digestAlgorithm}`, async () => {
      const root = path.join(tempdir, `root-${rootCount++}`);
      const layout = { extensionName: HASHED, digestAlgorithm, tupleSize: 1, numberOfTuples: 1 };
      const created = await ocfl.createStorage({ root, layout });
      await created.object('abc').update(async (t) => {
        await t.write('a.txt', 'content');
      });

      const loaded = await ocfl.loadStorage({ root });
      const object = loaded.object('abc');
      assert.strictEqual(object.root, path.join(root, digest.charAt(0), digest));
      await object.load();
      assert.strictEqual(await object.getFile('a.txt')?.text(), 'content');
    });
  }

  for (const [problem, extensionConfig] of [
    ['is not JSON', '{ truncated'],
    ['is empty', ''],
    ['has a null root', 'null'],
    ['has an array root', '[]'],
  ] as const) {
    it(`rejects a root whose extension config ${problem}`, async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig });
      await assert.rejects(
        ocfl.storage({ root }).load(),
        (error: OcflError) => error.code === 'INVALID_LAYOUT_CONFIG' && error.message.includes(path.join(root, 'extensions', HASHED, 'config.json')),
      );
    });

    it(`rejects a configured layout when the root extension config ${problem}`, async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig });
      await assert.rejects(ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: 4 } }).load(), { code: 'INVALID_LAYOUT_CONFIG' });
    });
  }

  it('loads a root with no extension config with the layout defaults', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED) });
    const storage = await ocfl.storage({ root }).load();
    assert.strictEqual(storage.objectRoot('abc'), path.join('ba7', '816', 'bf8', DIGESTS_OF_ABC.sha256));
  });

  it('loads a root with no ocfl_layout.json and no layout configured without a layout', async () => {
    const root = await createRoot();
    const storage = await ocfl.storage({ root }).load();
    assert.throws(() => storage.objectRoot('abc'), /No layout defined/);
  });

  it('rejects an unsupported declared layout before reading its extension config', async () => {
    const extension = '9999-unimplemented-layout';
    const root = await createRoot({ layoutFile: declaring(extension) });
    await fs.promises.mkdir(path.join(root, 'extensions', extension, 'config.json'), { recursive: true });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT' });
  });

  it('rejects a declared layout name that is a path before reading outside the root', async () => {
    const root = await createRoot({ layoutFile: declaring('../outside') });
    await fs.promises.mkdir(path.join(root, 'outside', 'config.json'), { recursive: true });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'UNSUPPORTED_LAYOUT' });
  });

  const namesConfigFile = (root: string) => (error: OcflError) =>
    error.code === 'INVALID_LAYOUT_CONFIG' && error.message.includes(path.join(root, 'extensions', HASHED, 'config.json'));

  for (const [problem, extensionConfig] of [
    ['an unknown digestAlgorithm', { digestAlgorithm: 'not-a-digest' }],
    ['a string tupleSize', { tupleSize: '3' }],
    ['tuples longer than the digest', { tupleSize: 32, numberOfTuples: 3 }],
  ] as const) {
    it(`rejects a root whose extension config has ${problem}, naming the file`, async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig });
      await assert.rejects(ocfl.storage({ root }).load(), namesConfigFile(root));
    });

    it(`rejects a configured layout when the root extension config has ${problem}, naming the file`, async () => {
      const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig });
      await assert.rejects(ocfl.storage({ root, layout: HASHED }).load(), namesConfigFile(root));
    });
  }

  it('rejects an invalid configured layout without naming a config file', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED) });
    assert.throws(
      () => ocfl.storage({ root, layout: { extensionName: HASHED, tupleSize: '3' } as never }),
      (error: OcflError) => error.code === 'INVALID_LAYOUT_CONFIG' && !error.message.includes('config.json'),
    );
  });

  it('rejects a root whose extension config cannot be read with the file system error', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED) });
    await fs.promises.mkdir(path.join(root, 'extensions', HASHED, 'config.json'), { recursive: true });
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'EISDIR' });
  });

  it('rejects a root whose ocfl_layout.json cannot be read with the file system error', async () => {
    const root = await createRoot();
    await fs.promises.mkdir(path.join(root, 'ocfl_layout.json'));
    await assert.rejects(ocfl.storage({ root }).load(), { code: 'EISDIR' });
    await assert.rejects(ocfl.storage({ root, layout: HASHED }).load(), { code: 'EISDIR' });
  });

  it('uses the layout and extension config of the root when no layout is configured', async () => {
    const root = await createRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 2 } });
    const storage = await ocfl.storage({ root }).load();
    assert.strictEqual(storage.objectRoot('abc'), path.join('ba', '78', '16', DIGESTS_OF_ABC.sha256));
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

  it('deletes nothing in the storage root extensions directory', async () => {
    const layout = { ...PATH_DIRECT, suffix: '' };
    const storage = await createRoot(layout);
    const donor = await createRoot(layout);
    const object = await createObject(donor, 'extensions/an-extension');
    const target = path.join(storage.root, 'extensions', 'an-extension');
    await fs.promises.cp(object.root, target, { recursive: true });
    await assert.rejects(storage.remove('extensions/an-extension'), { code: 'ID_INCOMPATIBLE_WITH_LAYOUT' });
    assert.strictEqual(fs.existsSync(path.join(target, 'inventory.json')), true);
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
