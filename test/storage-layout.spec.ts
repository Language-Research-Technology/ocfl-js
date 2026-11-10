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

describe('choosing a layout with invalid parameters', () => {
  const rowsFor = (extensionName: string, rows: [string, Record<string, unknown>][]): [string, OcflLayoutConfig][] =>
    rows.map(([problem, params]) => [`${problem} for ${extensionName.slice(0, 4)}`, { extensionName, ...params } as never]);
  const invalidParameters: [string, OcflLayoutConfig][] = [
    ['an unknown digestAlgorithm for 0003', { extensionName: '0003-hash-and-id-n-tuple-storage-layout', digestAlgorithm: 'nope' }],
    ['an unknown digestAlgorithm for 0004', { extensionName: '0004-hashed-n-tuple-storage-layout', digestAlgorithm: 'nope' }],
    ['tuples longer than the digest for 0003', { extensionName: '0003-hash-and-id-n-tuple-storage-layout', tupleSize: 33, numberOfTuples: 2 }],
    ['tuples longer than the digest for 0004', { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 33, numberOfTuples: 2 }],
    [
      'shortObjectRoot with tuples using the whole digest for 0004',
      { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 32, numberOfTuples: 2, shortObjectRoot: true },
    ],
    ...['0003-hash-and-id-n-tuple-storage-layout', '0004-hashed-n-tuple-storage-layout'].flatMap((extensionName) =>
      rowsFor(extensionName, [
        ['a string tupleSize', { tupleSize: '3' }],
        ['a string numberOfTuples', { numberOfTuples: 'x' }],
        ['a numeric digestAlgorithm', { digestAlgorithm: 5 }],
        ['an empty digestAlgorithm', { digestAlgorithm: '' }],
        ['a negative tupleSize', { tupleSize: -1 }],
        ['a fractional tupleSize', { tupleSize: 2.5 }],
        ['a NaN numberOfTuples', { numberOfTuples: Number.NaN }],
        ['numberOfTuples over 32', { tupleSize: 1, numberOfTuples: 33 }],
        ['tupleSize over 32', { tupleSize: 33, numberOfTuples: 1 }],
        ['a zero tupleSize with tuples', { tupleSize: 0, numberOfTuples: 3 }],
        ['tuples with a zero numberOfTuples', { tupleSize: 3, numberOfTuples: 0 }],
      ]),
    ),
    ...rowsFor('0004-hashed-n-tuple-storage-layout', [['a string shortObjectRoot', { shortObjectRoot: 'yes' }]]),
    ...rowsFor('000N-path-direct-storage-layout', [
      ['a string omitScheme', { omitScheme: 'yes' }],
      ['a numeric suffix', { suffix: 5 }],
      ['a string replace', { replace: 'abc' }],
      ['a replace pair without a replacement', { replace: [['a']] }],
      ['a replace pair with a numeric pattern', { replace: [[1, 'b']] }],
      ['a replace pair with a numeric replacement', { replace: [['a', 2]] }],
      ['a replace pair with three elements', { replace: [['a', 'b', 'c']] }],
      ['a replace entry that is not a pair', { replace: ['ab'] }],
    ]),
  ];
  for (const [entryPoint, choose] of invalidLayoutEntryPoints) {
    for (const [problem, layout] of invalidParameters) {
      it(`rejects ${problem} through ${entryPoint}`, () => {
        assert.throws(() => choose(layout as never), ocflError('INVALID_LAYOUT_CONFIG'));
      });
    }
  }
});

describe('storageLayout without a loaded storage', () => {
  const HASHED = '0004-hashed-n-tuple-storage-layout';

  const HASHED_DEFAULTS = { digestAlgorithm: 'sha256', tupleSize: 3, numberOfTuples: 3, shortObjectRoot: false };

  it('has the parameter defaults when chosen by name', () => {
    const layout = ocfl.storageLayout(HASHED);
    assert.strictEqual(layout.name, HASHED);
    assert.deepStrictEqual(layout.parameters, HASHED_DEFAULTS);
  });

  it('has the configured parameters and the defaults of the rest', () => {
    assert.deepStrictEqual(ocfl.storageLayout({ extensionName: HASHED, tupleSize: 2 }).parameters, { ...HASHED_DEFAULTS, tupleSize: 2 });
  });

  it('cannot have its parameters changed', () => {
    const { parameters } = ocfl.storageLayout(HASHED);
    assert.ok(Object.isFrozen(parameters));
  });

  it('ignores a parameter the layout does not declare', () => {
    // @ts-expect-error untyped callers can still pass it
    assert.deepStrictEqual(ocfl.storageLayout({ extensionName: HASHED, undeclared: 'ignored' }).parameters, HASHED_DEFAULTS);
  });

  it('has no parameters for the 0002 layout', () => {
    // @ts-expect-error untyped callers can still pass it
    assert.deepStrictEqual(ocfl.storageLayout({ extensionName: '0002-flat-direct-storage-layout', tupleSize: 2 }).parameters, {});
  });

  it('maps an id with the 0003 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0003-hash-and-id-n-tuple-storage-layout').map('object-01'), '3c0/ff4/240/object-01');
  });

  it('maps an id with the 0004 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').map('object-01'), `3c0/ff4/240/${SHA256_OF_OBJECT_01}`);
  });
});
