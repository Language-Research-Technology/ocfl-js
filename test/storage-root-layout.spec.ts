import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createStorageRoot, type LayoutConfig, OcflError, openStorageRoot } from '../src/index.ts';
import { HASHED, HASHED_DEFAULTS, INVALID_LAYOUT_PARAMETERS, UNSUPPORTED_LAYOUT_NAMES } from './helpers/layouts.ts';
import { writeObject } from './helpers/storage-roots.ts';

const SHA256_OF_OBJECT_01 = '3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4';
const N_TUPLE_DEFAULTS = { digestAlgorithm: 'sha256', tupleSize: 3, numberOfTuples: 3 };

const layouts: {
  name: LayoutConfig['extensionName'];
  id: string;
  defaults: Record<string, unknown>;
  byDefault: string;
  params: Record<string, unknown>;
  byConfig: string;
}[] = [
  { name: '0002-flat-direct-storage-layout', id: 'object-01', defaults: {}, byDefault: 'object-01', params: {}, byConfig: 'object-01' },
  {
    name: '0003-hash-and-id-n-tuple-storage-layout',
    id: 'object-01',
    defaults: N_TUPLE_DEFAULTS,
    byDefault: '3c0/ff4/240/object-01',
    params: { tupleSize: 2, numberOfTuples: 2 },
    byConfig: '3c/0f/object-01',
  },
  {
    name: HASHED,
    id: 'object-01',
    defaults: { ...N_TUPLE_DEFAULTS, shortObjectRoot: false },
    byDefault: `3c0/ff4/240/${SHA256_OF_OBJECT_01}`,
    params: { tupleSize: 2, numberOfTuples: 2 },
    byConfig: `3c/0f/${SHA256_OF_OBJECT_01}`,
  },
  {
    name: '000N-path-direct-storage-layout',
    id: 'a/b',
    defaults: { omitScheme: false, replace: [], suffix: '/__object__' },
    byDefault: 'a/b/__object__',
    params: { suffix: '/obj' },
    byConfig: 'a/b/obj',
  },
];

/** `assert.rejects` matcher for the `TypeError` that misuse throws, which is never an `OcflError` */
const misuse = (error: unknown) => error instanceof TypeError && !(error instanceof OcflError);

describe('choosing the layout of a new storage root', () => {
  let dir: string;
  let rootPath: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-layout-choice-'));
    rootPath = path.join(dir, 'root');
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const readJson = async (name: string) => JSON.parse(await fs.promises.readFile(path.join(rootPath, name), 'utf8'));

  for (const { name, id, defaults, byDefault, params, byConfig } of layouts) {
    it(`maps ids with ${name} chosen by name alone, with the defaults of its extension spec`, async () => {
      const created = await createStorageRoot(rootPath, { layout: { extensionName: name } as LayoutConfig });
      assert.deepStrictEqual(created.layout, { extensionName: name, ...defaults });
      assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, created.layout);
      assert.strictEqual(await writeObject(rootPath, id), byDefault);
      assert.ok(fs.existsSync(path.join(rootPath, byDefault, 'inventory.json')));
    });

    it(`maps ids with ${name} chosen with parameters`, async () => {
      const created = await createStorageRoot(rootPath, { layout: { extensionName: name, ...params } as LayoutConfig });
      assert.deepStrictEqual(created.layout, { extensionName: name, ...defaults, ...params });
      assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, created.layout);
      assert.strictEqual(await writeObject(rootPath, id), byConfig);
      assert.ok(fs.existsSync(path.join(rootPath, byConfig, 'inventory.json')));
    });

    it(`records no extension config for ${name} chosen with no parameters`, async () => {
      await createStorageRoot(rootPath, { layout: { extensionName: name } as LayoutConfig });
      assert.ok(!fs.existsSync(path.join(rootPath, `extensions/${name}/config.json`)));
    });
  }

  it('records only the layout name in a root created with no parameters', async () => {
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    assert.strictEqual((await readJson('ocfl_layout.json')).extension, HASHED);
    assert.ok(!fs.existsSync(path.join(rootPath, `extensions/${HASHED}/config.json`)));
  });

  it('records the chosen parameters in a root created with parameters', async () => {
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED, tupleSize: 2 } });
    assert.deepStrictEqual(await readJson(`extensions/${HASHED}/config.json`), { extensionName: HASHED, tupleSize: 2 });
  });

  it('describes each layout in ocfl_layout.json', async () => {
    for (const { name } of layouts) {
      rootPath = path.join(dir, name);
      await createStorageRoot(rootPath, { layout: { extensionName: name } as LayoutConfig });
      const { extension, description } = await readJson('ocfl_layout.json');
      assert.strictEqual(extension, name);
      assert.match(description, /^OCFL object identifiers are /);
    }
  });

  it('has the chosen parameters and the defaults of the rest', async () => {
    const root = await createStorageRoot(rootPath, { layout: { extensionName: HASHED, tupleSize: 2 } });
    assert.deepStrictEqual(root.layout, { ...HASHED_DEFAULTS, tupleSize: 2 });
  });

  it('cannot have its layout changed', async () => {
    const root = await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    assert.ok(Object.isFrozen(root.layout));
  });

  it('cannot have the replace pairs of its layout changed, nor the defaults of later storage roots', async () => {
    const PATH_DIRECT = '000N-path-direct-storage-layout';
    const root = await createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT } });
    assert.ok(root.layout.extensionName === PATH_DIRECT);
    const { replace } = root.layout;
    assert.throws(() => replace.push(['x', 'y']), TypeError);
    const later = await createStorageRoot(path.join(dir, 'later'), { layout: { extensionName: PATH_DIRECT } });
    assert.deepStrictEqual(later.layout, { extensionName: PATH_DIRECT, omitScheme: false, replace: [], suffix: '/__object__' });
  });

  it('keeps its replace pairs when the caller later changes the array it passed', async () => {
    const PATH_DIRECT = '000N-path-direct-storage-layout';
    const replace: [string, string][] = [['x', 'y']];
    const root = await createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT, replace } });
    replace[0]![1] = 'z';
    replace.push(['a', 'b']);
    assert.ok(root.layout.extensionName === PATH_DIRECT);
    assert.deepStrictEqual(root.layout.replace, [['x', 'y']]);
  });

  it('records the layout as it was when createStorageRoot was called, whatever the caller changes meanwhile', async () => {
    const PATH_DIRECT = '000N-path-direct-storage-layout';
    const replace = [['x', 'y']] as [string, string][];
    const creating = createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT, replace } });
    replace.push(['a', 1] as never);
    const expected = { extensionName: PATH_DIRECT, omitScheme: false, replace: [['x', 'y']], suffix: '/__object__' };
    assert.deepStrictEqual((await creating).layout, expected);
    assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, expected);
  });

  it('takes the default of a parameter given as undefined', async () => {
    const root = await createStorageRoot(rootPath, { layout: { extensionName: HASHED, tupleSize: undefined, numberOfTuples: 2 } as never });
    assert.deepStrictEqual(root.layout, { ...HASHED_DEFAULTS, numberOfTuples: 2 });
    assert.deepStrictEqual(await readJson(`extensions/${HASHED}/config.json`), { extensionName: HASHED, numberOfTuples: 2 });
  });

  it('rejects a layout holding a value that is not plain data', async () => {
    const layout = { extensionName: '000N-path-direct-storage-layout', replace: [['a', 'b'], () => 'c'] };
    await assert.rejects(createStorageRoot(rootPath, { layout: layout as never }), misuse);
    assert.ok(!fs.existsSync(rootPath), 'the directory was made');
  });

  for (const [problem, layout] of [
    ['a parameter no layout has', { extensionName: HASHED, undeclared: 'x' }],
    ['a misspelt parameter', { extensionName: HASHED, tuplesize: 2 }],
    ['a parameter of another layout', { extensionName: '0002-flat-direct-storage-layout', tupleSize: 2 }],
    ['an unknown parameter given as undefined', { extensionName: HASHED, undeclared: undefined }],
  ] as const) {
    it(`rejects ${problem}, naming it`, async () => {
      const [unknown] = Object.keys(layout).filter((name) => name !== 'extensionName');
      await assert.rejects(
        createStorageRoot(rootPath, { layout: layout as never }),
        (error: Error) => misuse(error) && error.message.includes(unknown!) && error.message.includes(layout.extensionName),
      );
      assert.ok(!fs.existsSync(rootPath), 'the directory was made');
    });
  }

  describe('a layout that is not supported', () => {
    const rejects = async (layout: unknown) => {
      await assert.rejects(createStorageRoot(rootPath, { layout: layout as never }), misuse);
      assert.ok(!fs.existsSync(rootPath), 'the directory was made');
    };

    it('rejects a layout that has no implementation', async () => {
      await rejects({ extensionName: '0006-flat-omit-prefix-storage-layout' });
    });

    for (const name of UNSUPPORTED_LAYOUT_NAMES) {
      it(`rejects ${name}`, async () => {
        await rejects(name);
        await rejects({ extensionName: name });
      });
    }

    it('rejects the name of a layout in place of a config object', async () => {
      await rejects(HASHED);
    });

    it('rejects the layout of another storage root that names no extension', async () => {
      await rejects({ name: '0002-flat-direct-storage-layout', parameters: {} });
    });

    it('rejects a config object with no extensionName', async () => {
      await rejects({ tupleSize: 2 });
    });

    it('rejects an empty name', async () => {
      await rejects('');
      await rejects({ extensionName: '' });
    });

    it('rejects null', async () => {
      await rejects(null);
    });
  });

  describe('a layout with invalid parameters', () => {
    for (const [problem, layout] of INVALID_LAYOUT_PARAMETERS) {
      it(`rejects ${problem}`, async () => {
        await assert.rejects(createStorageRoot(rootPath, { layout: layout as never }), misuse);
        assert.ok(!fs.existsSync(rootPath), 'the directory was made');
      });
    }

    it('says which parameter is wrong without naming a config file', async () => {
      await assert.rejects(
        createStorageRoot(rootPath, { layout: { extensionName: HASHED, tupleSize: '3' } as never }),
        (error: Error) => misuse(error) && error.message.includes('tupleSize') && !error.message.includes('config.json'),
      );
    });
  });
});
