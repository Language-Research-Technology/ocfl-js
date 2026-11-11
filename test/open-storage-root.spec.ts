import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStorageRoot, type OcflError, openStorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import { HASHED, HASHED_DEFAULTS } from './helpers/layouts.ts';
import { STORAGE_FIXTURE, specFiles, writeFiles, writeObject, writeStorageRoot } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';
import { DIGESTS_OF_ABC } from './shared/digests-of-abc.ts';

const FLAT = '0002-flat-direct-storage-layout';
const PATH_DIRECT = '000N-path-direct-storage-layout';

const declaring = (extension: unknown) => JSON.stringify({ extension });

describe('opening a storage root', () => {
  let tempdir: string;
  let rootCount = 0;
  const newPath = () => path.join(tempdir, `root-${rootCount++}`);

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-open-storage-root-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  /** An OCFL 1.1 storage root written by hand, with the given `ocfl_layout.json` and 0004 extension config */
  const handMadeRoot = async ({ layoutFile, extensionConfig }: { layoutFile?: string; extensionConfig?: object | string } = {}) => {
    const rootPath = newPath();
    const files: Record<string, string> = { '0=ocfl_1.1': 'ocfl_1.1\n' };
    if (layoutFile !== undefined) {
      files['ocfl_layout.json'] = layoutFile;
    }
    if (extensionConfig !== undefined) {
      files[`extensions/${HASHED}/config.json`] = typeof extensionConfig === 'string' ? extensionConfig : JSON.stringify(extensionConfig);
    }
    await writeFiles(rootPath, files);
    return rootPath;
  };
  const configFileOf = (rootPath: string) => path.join(rootPath, 'extensions', HASHED, 'config.json');
  /** Matcher for an `INVALID_STORAGE_ROOT` with no OCFL code, whose message names `file` */
  const invalidNaming = (file: string) => (error: OcflError) =>
    ocflError('INVALID_STORAGE_ROOT')(error) && error.ocflCode === undefined && error.message.includes(file);

  it('reports the absolute path of a storage root given by a relative path', async () => {
    const rootPath = newPath();
    await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
    const root = await openStorageRoot(path.relative(process.cwd(), rootPath));
    assert.strictEqual(root.path, rootPath);
  });

  it('cannot have its properties changed', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);
    assert.ok(Object.isFrozen(root));
    assert.ok(Object.isFrozen(root.layout));
  });

  it('opens a path-direct root that has no description of its layout, writing nothing to it', async () => {
    const rootPath = newPath();
    await fs.promises.cp(STORAGE_FIXTURE, rootPath, { recursive: true });
    const listing = () => fs.promises.readdir(rootPath, { recursive: true });
    const before = await listing();
    const root = await openStorageRoot(rootPath);
    assert.strictEqual(root.layout.extensionName, PATH_DIRECT);
    assert.deepStrictEqual(await listing(), before);
    assert.ok(!before.includes(`${PATH_DIRECT}.md`));
  });

  it('requires a path', async () => {
    await assert.rejects(openStorageRoot(''), TypeError);
    await assert.rejects(openStorageRoot(undefined as never), TypeError);
  });

  describe('OCFL version', () => {
    for (const ocflVersion of ['1.0', '1.1'] as const) {
      it(`takes the version from a ${ocflVersion} root`, async () => {
        const rootPath = newPath();
        await writeStorageRoot(rootPath, ocflVersion);
        assert.strictEqual((await openStorageRoot(rootPath)).ocflVersion, ocflVersion);
      });
    }

    it('takes version 1.1 from a root it created', async () => {
      const rootPath = newPath();
      await createStorageRoot(rootPath, { layout: { extensionName: HASHED } });
      assert.strictEqual((await openStorageRoot(rootPath)).ocflVersion, '1.1');
    });
  });

  describe('OCFL spec text', () => {
    it('does not add a spec file to a root that has none', async () => {
      const rootPath = newPath();
      await writeStorageRoot(rootPath, '1.1');
      await openStorageRoot(rootPath);
      assert.deepStrictEqual(await specFiles(rootPath), []);
    });

    for (const [ocflVersion, file] of [
      ['1.1', 'ocfl_1.1.md'],
      ['1.0', 'ocfl_1.0.txt'],
    ] as const) {
      it(`ignores the spec file of a ${ocflVersion} root`, async () => {
        const rootPath = newPath();
        await writeStorageRoot(rootPath, ocflVersion);
        await writeFiles(rootPath, { [file]: 'the spec' });
        const root = await openStorageRoot(rootPath);
        assert.strictEqual(root.ocflVersion, ocflVersion);
        assert.deepStrictEqual(root.layout, HASHED_DEFAULTS);
      });
    }
  });

  describe('layout', () => {
    it('takes the layout and its parameters from the root', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED), extensionConfig: { extensionName: HASHED, tupleSize: 2 } });
      assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, { ...HASHED_DEFAULTS, tupleSize: 2 });
      assert.strictEqual(await writeObject(rootPath, 'abc'), path.join('ba', '78', '16', DIGESTS_OF_ABC.sha256));
    });

    it('takes the layout defaults for a root with no extension config', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED) });
      assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, HASHED_DEFAULTS);
      assert.strictEqual(await writeObject(rootPath, 'abc'), path.join('ba7', '816', 'bf8', DIGESTS_OF_ABC.sha256));
    });

    it('uses the layout named in ocfl_layout.json when its extension config has no name', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED), extensionConfig: { tupleSize: 4 } });
      assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, { ...HASHED_DEFAULTS, tupleSize: 4 });
    });

    it('opens a root created with replace pairs', async () => {
      const rootPath = newPath();
      await createStorageRoot(rootPath, { layout: { extensionName: PATH_DIRECT, replace: [['x', 'y']] } });
      const root = await openStorageRoot(rootPath);
      assert.deepStrictEqual(root.layout, { extensionName: PATH_DIRECT, omitScheme: false, replace: [['x', 'y']], suffix: '/__object__' });
      assert.strictEqual(await writeObject(rootPath, 'xa'), path.join('ya', '__object__'));
    });

    for (const [digestAlgorithm, digest] of Object.entries(DIGESTS_OF_ABC)) {
      it(`creates, writes to and reopens a root hashed with ${digestAlgorithm}`, async () => {
        const rootPath = newPath();
        const layout = { extensionName: HASHED, digestAlgorithm, tupleSize: 1, numberOfTuples: 1 } as const;
        await createStorageRoot(rootPath, { layout });
        assert.strictEqual(await writeObject(rootPath, 'abc'), path.join(digest.charAt(0), digest));
        assert.deepStrictEqual((await openStorageRoot(rootPath)).layout, { ...layout, shortObjectRoot: false });
      });
    }

    it('rejects a root with no ocfl_layout.json, saying why', async () => {
      const rootPath = await handMadeRoot();
      await assert.rejects(openStorageRoot(rootPath), invalidNaming('ocfl_layout.json'));
    });

    for (const [problem, layoutFile] of [
      ['is not JSON', 'not json'],
      ['is empty', ''],
      ['has a non-object root', 'null'],
      ['has no extension', '{}'],
      ['has a non-string extension', '{"extension":5}'],
      ['has a non-string extension holding a supported name', declaring([FLAT])],
    ] as const) {
      it(`rejects a root whose ocfl_layout.json ${problem}`, async () => {
        const rootPath = await handMadeRoot({ layoutFile });
        await assert.rejects(
          openStorageRoot(rootPath),
          (error: OcflError) => ocflError('INVALID_STORAGE_ROOT', 'E070')(error) && error.message.includes(path.join(rootPath, 'ocfl_layout.json')),
        );
      });
    }

    for (const extension of [
      'no-such-layout',
      '0006-flat-omit-prefix-storage-layout',
      '0007-n-tuple-omit-prefix-storage-layout',
      '9999-unimplemented-layout',
      'constructor',
    ]) {
      it(`rejects a root declaring ${extension}`, async () => {
        const rootPath = await handMadeRoot({ layoutFile: declaring(extension) });
        await assert.rejects(openStorageRoot(rootPath), { code: 'UNSUPPORTED_LAYOUT', message: new RegExp(extension) });
      });

      it(`rejects a root declaring ${extension} whose extension config names a layout this library implements`, async () => {
        const rootPath = await handMadeRoot({ layoutFile: declaring(extension) });
        await writeFiles(rootPath, { [`extensions/${extension}/config.json`]: JSON.stringify({ extensionName: FLAT }) });
        await assert.rejects(openStorageRoot(rootPath), { code: 'UNSUPPORTED_LAYOUT', message: new RegExp(extension) });
      });
    }

    it('rejects a root whose ocfl_layout.json extension is empty', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring('') });
      await assert.rejects(openStorageRoot(rootPath), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it('rejects an unsupported declared layout before reading its extension config', async () => {
      const extension = '9999-unimplemented-layout';
      const rootPath = await handMadeRoot({ layoutFile: declaring(extension) });
      await fs.promises.mkdir(path.join(rootPath, 'extensions', extension, 'config.json'), { recursive: true });
      await assert.rejects(openStorageRoot(rootPath), ocflError('UNSUPPORTED_LAYOUT'));
    });

    it('rejects a declared layout name that is a path before reading outside the root', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring('../outside') });
      await fs.promises.mkdir(path.join(rootPath, 'outside', 'config.json'), { recursive: true });
      await assert.rejects(openStorageRoot(rootPath), ocflError('UNSUPPORTED_LAYOUT'));
    });

    for (const [problem, extensionConfig] of [
      ['is not JSON', '{ truncated'],
      ['is empty', ''],
      ['has a null root', 'null'],
      ['has an array root', '[]'],
      ['has an unknown digestAlgorithm', { digestAlgorithm: 'not-a-digest' }],
      ['has a string tupleSize', { tupleSize: '3' }],
      ['has tuples longer than the digest', { tupleSize: 32, numberOfTuples: 3 }],
      ['names another layout this library implements', { extensionName: FLAT }],
      ['names a layout this library does not implement', { extensionName: 'no-such-layout' }],
      ['has a non-string extensionName holding the declared name', { extensionName: [HASHED] }],
    ] as const) {
      it(`rejects a root whose extension config ${problem}, naming the file`, async () => {
        const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED), extensionConfig });
        await assert.rejects(openStorageRoot(rootPath), invalidNaming(configFileOf(rootPath)));
      });
    }
  });

  describe('a storage root that breaks an OCFL rule', () => {
    it('reports E069 when the root conformance declaration is missing', async () => {
      const rootPath = newPath();
      await fs.promises.mkdir(rootPath);
      await assert.rejects(openStorageRoot(rootPath), ocflError('INVALID_STORAGE_ROOT', 'E069'));
      assert.deepStrictEqual(await fs.promises.readdir(rootPath), []);
    });

    it('reports E069 when the root does not exist, without making it', async () => {
      const rootPath = newPath();
      await assert.rejects(openStorageRoot(rootPath), ocflError('INVALID_STORAGE_ROOT', 'E069'));
      assert.ok(!fs.existsSync(rootPath));
    });

    it('reports E069 when the root is a file', async () => {
      const rootPath = newPath();
      await fs.promises.writeFile(rootPath, 'x');
      await assert.rejects(openStorageRoot(rootPath), ocflError('INVALID_STORAGE_ROOT', 'E069'));
    });

    it('reports E080 when the version declaration has the wrong contents', async () => {
      const rootPath = newPath();
      await writeFiles(rootPath, { '0=ocfl_1.1': 'wrong\n', 'ocfl_layout.json': declaring(HASHED) });
      await assert.rejects(openStorageRoot(rootPath), ocflError('INVALID_STORAGE_ROOT', 'E080'));
    });

    it('names the storage root and keeps the cause', async () => {
      const rootPath = newPath();
      await assert.rejects(openStorageRoot(rootPath), (error: OcflError) => error.message.includes(rootPath) && error.cause instanceof Error);
    });
  });

  describe('a file system error', () => {
    it('passes through when the declaration cannot be read', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED) });
      const declaration = (filePath: string) => path.basename(filePath).startsWith('0=ocfl_');
      await withFsFailure('readFile', declaration, () => assert.rejects(openStorageRoot(rootPath), { code: 'EACCES' }), 'EACCES');
    });

    it('passes through when ocfl_layout.json cannot be read', async () => {
      const rootPath = await handMadeRoot();
      await fs.promises.mkdir(path.join(rootPath, 'ocfl_layout.json'));
      await assert.rejects(openStorageRoot(rootPath), { code: 'EISDIR' });
    });

    it('passes through when the extension config cannot be read', async () => {
      const rootPath = await handMadeRoot({ layoutFile: declaring(HASHED) });
      await withFsFailure('readFile', configFileOf(rootPath), () => assert.rejects(openStorageRoot(rootPath), { code: 'EACCES' }), 'EACCES');
      await fs.promises.mkdir(configFileOf(rootPath), { recursive: true });
      await assert.rejects(openStorageRoot(rootPath), { code: 'EISDIR' });
    });
  });
});
