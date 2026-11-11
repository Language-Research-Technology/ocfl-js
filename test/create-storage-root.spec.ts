import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { createStorageRoot, openStorageRoot } from '../src/index.ts';
import { fsError, stillOpen, trackOpendir, withFsFailure } from './fs-failures.ts';
import { HASHED } from './helpers/layouts.ts';
import { specFiles, writeObject } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

describe('creating a storage root', () => {
  let tempdir: string;
  let rootCount = 0;
  const newPath = () => path.join(tempdir, `root-${rootCount++}`);

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-create-storage-root-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('makes an OCFL 1.1 storage root in a directory that does not exist', async () => {
    const rootPath = path.join(newPath(), 'nested');
    const root = await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    assert.strictEqual(root.path, rootPath);
    assert.strictEqual(root.ocflVersion, '1.1');
    assert.strictEqual(await fs.promises.readFile(path.join(rootPath, '0=ocfl_1.1'), 'utf8'), 'ocfl_1.1\n');
  });

  it('makes a storage root in an empty directory', async () => {
    const rootPath = newPath();
    await fs.promises.mkdir(rootPath);
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    assert.ok(fs.existsSync(path.join(rootPath, '0=ocfl_1.1')));
  });

  it('reports the absolute path of a storage root given by a relative path', async () => {
    const rootPath = newPath();
    const root = await createStorageRoot(path.relative(process.cwd(), rootPath), { layout: { extensionName: HASHED } });
    assert.strictEqual(root.path, rootPath);
  });

  it('cannot have its properties changed', async () => {
    const root = await createStorageRoot(newPath(), { layout: { extensionName: HASHED } });
    assert.ok(Object.isFrozen(root));
  });

  it('requires a path', async () => {
    await assert.rejects(createStorageRoot('', { layout: { extensionName: HASHED } }), TypeError);
    await assert.rejects(createStorageRoot(undefined as never, { layout: { extensionName: HASHED } }), TypeError);
  });

  it('requires a layout', async () => {
    const rootPath = newPath();
    await assert.rejects(createStorageRoot(rootPath, {} as never), TypeError);
    await assert.rejects(createStorageRoot(rootPath, undefined as never), TypeError);
    assert.ok(!fs.existsSync(rootPath));
  });

  it('rejects creating a storage root in a non-empty directory, leaving it as it was', async () => {
    const rootPath = newPath();
    await fs.promises.mkdir(rootPath);
    await fs.promises.writeFile(path.join(rootPath, 'stray.txt'), 'x');
    await assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), ocflError('DIRECTORY_NOT_EMPTY'));
    assert.deepStrictEqual(await fs.promises.readdir(rootPath), ['stray.txt']);
  });

  it('rejects creating a storage root over an existing one', async () => {
    const rootPath = newPath();
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    await assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), ocflError('DIRECTORY_NOT_EMPTY'));
  });

  it('rejects a path that is a file with the file system error', async () => {
    const rootPath = newPath();
    await fs.promises.writeFile(rootPath, 'x');
    await assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), { code: 'EEXIST' });
    assert.strictEqual(await fs.promises.readFile(rootPath, 'utf8'), 'x');
  });

  it('rejects a path below a file with the file system error', async () => {
    const parent = newPath();
    await fs.promises.writeFile(parent, 'x');
    await assert.rejects(createStorageRoot(path.join(parent, 'root'), { layout: { extensionName: HASHED } }), { code: 'ENOTDIR' });
  });

  it('rejects with the file system error when the directory cannot be made', async () => {
    const rootPath = newPath();
    await withFsFailure(
      'mkdir',
      rootPath,
      () => assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), { code: 'EACCES' }),
      'EACCES',
    );
  });

  it('rejects with the file system error when the directory cannot be opened', async () => {
    const rootPath = newPath();
    await withFsFailure('opendir', rootPath, () => assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), { code: 'EIO' }));
  });

  it('rejects with the file system error and closes the directory it opened when reading it fails', async () => {
    const rootPath = newPath();
    const opened = await trackOpendir(async () => {
      const read = mock.method(fs.Dir.prototype, 'read', async () => {
        throw fsError('EIO');
      });
      try {
        await assert.rejects(createStorageRoot(rootPath, { layout: { extensionName: HASHED } }), { code: 'EIO' });
      } finally {
        read.mock.restore();
      }
    });
    assert.strictEqual(opened.length, 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });

  it('leaves a directory that does not open as a storage root when writing it fails part-way', async () => {
    const rootPath = newPath();
    const layout = { extensionName: HASHED, tupleSize: 2 } as const;
    const configFile = path.join(rootPath, 'extensions', HASHED, 'config.json');
    await withFsFailure('writeFile', configFile, () => assert.rejects(createStorageRoot(rootPath, { layout }), { code: 'EIO' }));
    await assert.rejects(openStorageRoot(rootPath), ocflError('INVALID_STORAGE_ROOT', 'E069'));
  });

  it('writes the OCFL 1.1 spec text into the storage root', async () => {
    const rootPath = newPath();
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    const resource = path.join(import.meta.dirname, '../resources/ocfl_1.1.md');
    assert.deepStrictEqual(await fs.promises.readFile(path.join(rootPath, 'ocfl_1.1.md')), await fs.promises.readFile(resource));
    assert.deepStrictEqual(await specFiles(rootPath), ['ocfl_1.1.md']);
  });

  it('documents the workspace as a local extension in a new storage root', async () => {
    const rootPath = newPath();
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    const text = await fs.promises.readFile(path.join(rootPath, 'ocfl-js-workspace.md'), 'utf8');
    assert.match(text, /extensions\/ocfl-js-workspace/);
  });

  describe('describing the path-direct layout', () => {
    const PATH_DIRECT = '000N-path-direct-storage-layout';

    it('describes the layout, its parameters and their defaults in a root that uses it', async () => {
      const rootPath = newPath();
      await createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT, omitScheme: true } });
      const text = await fs.promises.readFile(path.join(rootPath, `${PATH_DIRECT}.md`), 'utf8');
      assert.match(text, new RegExp(`^# ${PATH_DIRECT}\n`));
      for (const parameter of [/`omitScheme`.*`false`/s, /`replace`.*`\[\]`/s, /`suffix`.*`\/__object__`/s]) {
        assert.match(text, parameter);
      }
    });

    it('gives an example mapping that the layout really makes', async () => {
      const rootPath = newPath();
      await createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT } });
      const text = await fs.promises.readFile(path.join(rootPath, `${PATH_DIRECT}.md`), 'utf8');
      const examples = [...text.matchAll(/^\| `(?<id>[^`]+)` +\| `(?<objectRoot>[^`]+)` +\|$/gm)].map((match) => match.groups!);
      assert.ok(examples.length > 0, 'no example found');
      for (const { id, objectRoot } of examples) {
        const exampleRoot = newPath();
        await createStorageRoot(exampleRoot, { layout: { extensionName: PATH_DIRECT } });
        assert.strictEqual(await writeObject(exampleRoot, id!), objectRoot);
      }
    });

    for (const extensionName of ['0002-flat-direct-storage-layout', '0003-hash-and-id-n-tuple-storage-layout', HASHED] as const) {
      it(`writes no layout description into a root that uses ${extensionName}`, async () => {
        const rootPath = newPath();
        await createStorageRoot(rootPath, { layout: { extensionName } });
        const described = (await fs.promises.readdir(rootPath)).filter((name) => name.endsWith('.md'));
        assert.deepStrictEqual(described.sort(), ['ocfl-js-workspace.md', 'ocfl_1.1.md']);
      });
    }
  });
});
