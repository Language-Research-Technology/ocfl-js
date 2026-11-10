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

  it('leaves a storage without a layout when the option is null', () => {
    const storage = ocfl.storage({ root: path.join(dir, 'root'), layout: null as never });
    assert.throws(() => storage.objectRoot('abc'), /No layout defined/);
  });
});

describe('choosing a layout that is not supported', () => {
  for (const [entryPoint, choose] of invalidLayoutEntryPoints) {
    it(`rejects an unknown name through ${entryPoint}`, () => {
      assert.throws(() => choose('no-such-layout' as never), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it(`rejects a class name through ${entryPoint}`, () => {
      assert.throws(() => choose('FlatDirectStorageLayout' as never), ocflError('UNSUPPORTED_LAYOUT'));
      assert.throws(() => choose({ extensionName: 'FlatDirectStorageLayout' } as never), ocflError('UNSUPPORTED_LAYOUT'));
    });

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
  }
});

describe('storageLayout without a loaded storage', () => {
  it('maps an id with the 0003 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0003-hash-and-id-n-tuple-storage-layout').map('object-01'), '3c0/ff4/240/object-01');
  });

  it('maps an id with the 0004 layout', () => {
    assert.strictEqual(
      ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').map('object-01'),
      '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4',
    );
  });
});
