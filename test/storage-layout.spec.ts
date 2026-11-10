import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import ocfl, { type OcflLayoutConfig, type OcflLayoutName } from '../src/index.ts';
import { ocflError } from './ocfl-error.ts';

const invalidLayoutEntryPoints: [string, (layout: never) => unknown][] = [
  ['the layout option', (layout) => ocfl.storage({ root: '/tmp/ocfl-unused', layout })],
  ['storageLayout()', (layout) => ocfl.storageLayout(layout)],
];

const SHA256_OF_OBJECT_01 = '3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4';

const builtInLayouts: { name: OcflLayoutName; id: string; byName: string; params: Record<string, unknown>; byConfig: string }[] = [
  { name: '0002-flat-direct-storage-layout', id: 'object-01', byName: 'object-01', params: {}, byConfig: 'object-01' },
  {
    name: '0003-hash-and-id-n-tuple-storage-layout',
    id: 'object-01',
    byName: '3c0/ff4/240/object-01',
    params: { tupleSize: 2, numberOfTuples: 2 },
    byConfig: '3c/0f/object-01',
  },
  {
    name: '0004-hashed-n-tuple-storage-layout',
    id: 'object-01',
    byName: `3c0/ff4/240/${SHA256_OF_OBJECT_01}`,
    params: { tupleSize: 2, numberOfTuples: 2 },
    byConfig: `3c/0f/${SHA256_OF_OBJECT_01}`,
  },
  { name: '000N-path-direct-storage-layout', id: 'a/b', byName: 'a/b/__object__', params: { suffix: '/obj' }, byConfig: 'a/b/obj' },
];

describe('choosing a built-in layout', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-layout-choice-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  for (const { name, id, byName, params, byConfig } of builtInLayouts) {
    const config: OcflLayoutConfig = { extensionName: name, ...params };

    it(`maps ids with ${name} chosen by its official name`, async () => {
      assert.strictEqual(ocfl.storageLayout(name).map(id), byName);
      const root = path.join(dir, 'root');
      const created = await ocfl.createStorage({ root, layout: name });
      await created.object(id).update(async (t) => t.write('a.txt', 'content'));
      assert.ok(fs.existsSync(path.join(root, byName, 'inventory.json')));
      assert.strictEqual((await ocfl.loadStorage({ root, layout: name })).objectRoot(id), byName);
    });

    it(`maps ids with ${name} chosen by a config object`, async () => {
      assert.strictEqual(ocfl.storageLayout(config).map(id), byConfig);
      const root = path.join(dir, 'root');
      const created = await ocfl.createStorage({ root, layout: config });
      await created.object(id).update(async (t) => t.write('a.txt', 'content'));
      assert.ok(fs.existsSync(path.join(root, byConfig, 'inventory.json')));
      assert.strictEqual((await ocfl.loadStorage({ root, layout: config })).objectRoot(id), byConfig);
    });
  }

  const declaredLayout = async (root: string, name: string) => JSON.parse(await fs.promises.readFile(path.join(root, name), 'utf8'));

  it('records only the layout name in a root created by name', async () => {
    const root = path.join(dir, 'root');
    await ocfl.createStorage({ root, layout: '0004-hashed-n-tuple-storage-layout' });
    assert.strictEqual((await declaredLayout(root, 'ocfl_layout.json')).extension, '0004-hashed-n-tuple-storage-layout');
    assert.ok(!fs.existsSync(path.join(root, 'extensions/0004-hashed-n-tuple-storage-layout/config.json')));
  });

  it('records the configured parameters in a root created by config', async () => {
    const root = path.join(dir, 'root');
    await ocfl.createStorage({ root, layout: { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 2 } });
    assert.deepStrictEqual(await declaredLayout(root, 'extensions/0004-hashed-n-tuple-storage-layout/config.json'), {
      extensionName: '0004-hashed-n-tuple-storage-layout',
      tupleSize: 2,
    });
  });

  for (const { name } of builtInLayouts) {
    it(`records no extension config for ${name} chosen by a config object with no parameters`, async () => {
      const root = path.join(dir, 'root');
      await ocfl.createStorage({ root, layout: { extensionName: name } });
      assert.ok(!fs.existsSync(path.join(root, `extensions/${name}/config.json`)));
    });
  }

  it('describes each built-in layout in ocfl_layout.json', async () => {
    for (const { name } of builtInLayouts) {
      const root = path.join(dir, name);
      await ocfl.createStorage({ root, layout: name });
      const { extension, description } = await declaredLayout(root, 'ocfl_layout.json');
      assert.strictEqual(extension, name);
      assert.match(description, /^OCFL object identifiers are /);
    }
  });
});

describe('choosing a layout that is not supported', () => {
  it('rejects creating a storage root with a layout that has no implementation', async () => {
    await assert.rejects(
      ocfl.createStorage({ root: '/tmp/ocfl-unused', layout: '0006-flat-omit-prefix-storage-layout' as never }),
      ocflError('UNSUPPORTED_LAYOUT'),
    );
  });

  for (const [entryPoint, choose] of invalidLayoutEntryPoints) {
    for (const name of [
      'no-such-layout',
      '0006-flat-omit-prefix-storage-layout',
      '0007-n-tuple-omit-prefix-storage-layout',
      '0009-digest-algorithms',
      'FlatDirectStorageLayout',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      it(`rejects ${name} through ${entryPoint}`, () => {
        assert.throws(() => choose(name as never), ocflError('UNSUPPORTED_LAYOUT'));
        assert.throws(() => choose({ extensionName: name } as never), ocflError('UNSUPPORTED_LAYOUT'));
      });
    }

    it(`rejects a layout object through ${entryPoint}`, () => {
      const layout = ocfl.storageLayout('0002-flat-direct-storage-layout');
      assert.throws(() => choose(layout as never), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it(`rejects a config object with no extensionName through ${entryPoint}`, () => {
      assert.throws(() => choose({ tupleSize: 2 } as never), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it(`rejects an empty name through ${entryPoint}`, () => {
      assert.throws(() => choose('' as never), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it(`rejects null through ${entryPoint}`, () => {
      assert.throws(() => choose(null as never), ocflError('UNSUPPORTED_LAYOUT'));
    });
  }
});

describe('storageLayout without a loaded storage', () => {
  const HASHED = '0004-hashed-n-tuple-storage-layout';

  it('reads a parameter default when chosen by name', () => {
    const layout = ocfl.storageLayout(HASHED);
    assert.strictEqual(layout.get('digestAlgorithm'), 'sha256');
    assert.strictEqual(layout.get('tupleSize'), 3);
    assert.strictEqual(layout.get('numberOfTuples'), 3);
    assert.strictEqual(layout.get('shortObjectRoot'), false);
  });

  it('reads configured parameters and keeps the defaults of the rest', () => {
    const layout = ocfl.storageLayout({ extensionName: HASHED, tupleSize: 2 });
    assert.strictEqual(layout.get('tupleSize'), 2);
    assert.strictEqual(layout.get('numberOfTuples'), 3);
  });

  it('ignores a parameter the layout does not declare', () => {
    // @ts-expect-error untyped callers can still pass it
    assert.strictEqual(ocfl.storageLayout({ extensionName: HASHED, undeclared: 'ignored' }).get('undeclared'), undefined);
  });

  it('has no parameters for the 0002 layout', () => {
    // @ts-expect-error untyped callers can still pass it
    assert.strictEqual(ocfl.storageLayout({ extensionName: '0002-flat-direct-storage-layout', tupleSize: 2 }).get('tupleSize'), undefined);
  });

  it('maps an id with the 0003 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0003-hash-and-id-n-tuple-storage-layout').map('object-01'), '3c0/ff4/240/object-01');
  });

  it('maps an id with the 0004 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').map('object-01'), `3c0/ff4/240/${SHA256_OF_OBJECT_01}`);
  });
});
