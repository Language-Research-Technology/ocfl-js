import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type Draft, type OcflObject, openStorageRoot, type StorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import {
  assertVersionValid,
  createObject,
  DETAILS,
  FLAT,
  objectRootOf,
  readInventory,
  sha512,
  snapshot,
  storedFiles,
  textFiles,
  useTempRoots,
  workspaceOf,
} from './helpers/drafts.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import { writeFiles, writeStorageRoot } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

/** What an object shows of itself and its versions, for comparing two views of one object */
async function described(object: OcflObject): Promise<unknown> {
  return {
    id: object.id,
    ocflVersion: object.ocflVersion,
    digestAlgorithm: object.digestAlgorithm,
    head: object.head.number,
    versions: await Promise.all(
      Array.from(object.versions.values(), async ({ number, created, message, user, files }) => ({
        number,
        created,
        message,
        user,
        digests: Object.fromEntries(Array.from(files, ([logicalPath, file]) => [logicalPath, file.digest])),
        texts: await textFiles({ number, created, files }),
      })),
    ),
  };
}

describe('creating an object', () => {
  const temp = useTempRoots('ocfl-create-object-');
  const { newRoot } = temp;

  it('writes version 1 with the files the draft was given', async () => {
    const root = await newRoot();
    const object = await root.create('an-object', DETAILS, async (draft) => {
      await draft.write('a.txt', 'one');
      await draft.write('dir/b.txt', 'two');
    });
    assert.strictEqual(object.id, 'an-object');
    assert.strictEqual(object.head.number, 1);
    assert.deepStrictEqual([...object.versions.keys()], [1]);
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'one', 'dir/b.txt': 'two' });
    assert.deepStrictEqual(await storedFiles(objectRootOf(root, 'an-object'), 'v1'), ['v1/content/a.txt', 'v1/content/dir/b.txt']);
    await assertVersionValid(objectRootOf(root, 'an-object'), 'v1');
  });

  it('records the message and user it was given', async () => {
    const root = await newRoot();
    const before = Date.now();
    const object = await root.create(
      'recorded',
      { message: 'Initial deposit', user: { name: 'Alice', address: 'https://orcid.org/0000-0001' } },
      async (draft) => {
        await draft.write('a.txt', 'one');
      },
    );
    assert.strictEqual(object.head.message, 'Initial deposit');
    assert.deepStrictEqual(object.head.user, { name: 'Alice', address: 'https://orcid.org/0000-0001' });
    assert.ok(object.head.created.getTime() >= before && object.head.created.getTime() <= Date.now());
    const { versions } = await readInventory(objectRootOf(root, 'recorded'));
    assert.strictEqual(versions.v1?.message, 'Initial deposit');
    assert.deepStrictEqual(versions.v1?.user, { name: 'Alice', address: 'https://orcid.org/0000-0001' });
  });

  it('records a user who has no address, and nothing else the caller put on the user', async () => {
    const root = await newRoot();
    const user = { name: 'Alice', role: 'admin' };
    const object = await root.create('no-address', { message: 'Initial deposit', user }, async () => {});
    assert.deepStrictEqual(object.head.user, { name: 'Alice' });
    assert.deepStrictEqual((await readInventory(objectRootOf(root, 'no-address'))).versions.v1?.user, { name: 'Alice' });
  });

  it('returns an object that matches the object opened afresh', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'matching', { 'a.txt': 'one', 'dir/b.txt': 'two' });
    assert.deepStrictEqual(await described(object), await described(await root.open('matching')));
    assert.ok(Object.isFrozen(object));
    assert.deepStrictEqual(Object.keys(object).sort(), ['digestAlgorithm', 'head', 'id', 'ocflVersion', 'versions']);
  });

  it('writes version 1 even when the draft is given no files', async () => {
    const root = await newRoot();
    const object = await root.create('empty', DETAILS, async () => {});
    assert.strictEqual(object.head.number, 1);
    assert.strictEqual(object.head.files.size, 0);
    assert.strictEqual(object.head.message, DETAILS.message);
    assert.strictEqual((await root.open('empty')).head.files.size, 0);
    assert.deepStrictEqual((await fs.promises.readdir(objectRootOf(root, 'empty'))).sort(), [
      '0=ocfl_object_1.1',
      'inventory.json',
      'inventory.json.sha512',
      'v1',
    ]);
    const inventory = await readInventory(objectRootOf(root, 'empty'));
    assert.deepStrictEqual(inventory.manifest, {});
    assert.deepStrictEqual(inventory.versions.v1?.state, {});
  });

  it('creates an object in a directory that is already there but empty', async () => {
    const root = await newRoot();
    await fs.promises.mkdir(objectRootOf(root, 'made-ahead'));
    const object = await createObject(root, 'made-ahead', { 'a.txt': 'one' });
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'one' });
  });

  it('creates an object where a hashed layout places it', async () => {
    const root = await newRoot({ extensionName: HASHED });
    await createObject(root, 'http://example.org/hashed', { 'a.txt': 'one' });
    const opened = await (await openStorageRoot(root.path)).open('http://example.org/hashed');
    assert.deepStrictEqual(await textFiles(opened.head), { 'a.txt': 'one' });
    assert.ok(!fs.existsSync(workspaceOf(root)));
  });

  it('assembles the version in the workspace, and leaves no workspace behind', async () => {
    const root = await newRoot();
    const assembling = path.join(workspaceOf(root), 'assembled', 'v1');
    await root.create('assembled', DETAILS, async (draft) => {
      await draft.write('a.txt', 'one');
      assert.deepStrictEqual(await snapshot(assembling), { 'content/a.txt': 'one' });
      assert.ok(!fs.existsSync(objectRootOf(root, 'assembled')));
    });
    assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
    assert.deepStrictEqual((await fs.promises.readdir(root.path)).sort(), [
      '0=ocfl_1.1',
      'assembled',
      'ocfl-js-workspace.md',
      'ocfl_1.1.md',
      'ocfl_layout.json',
    ]);
  });

  describe('what a new object is made of', () => {
    const roots: [string, () => Promise<StorageRoot>][] = [
      ['1.1', () => newRoot()],
      [
        '1.0',
        async () => {
          const rootPath = path.join(temp.dir, 'root-1.0');
          await writeStorageRoot(rootPath, '1.0');
          await writeFiles(rootPath, { 'ocfl_layout.json': JSON.stringify({ extension: FLAT.extensionName }) });
          return openStorageRoot(rootPath);
        },
      ],
    ];

    for (const [ocflVersion, makeRoot] of roots) {
      it(`has the declaration, inventory and sidecar of OCFL ${ocflVersion} in a ${ocflVersion} storage root`, async () => {
        const root = await makeRoot();
        assert.strictEqual(root.ocflVersion, ocflVersion);
        const object = await root.create('made', { message: 'test commit', user: { name: 'john', address: 'mailto:john@test.com' } }, async (draft) => {
          await draft.write('test.txt', 'test');
        });
        assert.strictEqual(object.ocflVersion, ocflVersion);
        assert.strictEqual((await root.open('made')).ocflVersion, ocflVersion);
        assert.strictEqual(object.digestAlgorithm, 'sha512');

        const objectRoot = objectRootOf(root, 'made');
        assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), [
          `0=ocfl_object_${ocflVersion}`,
          'inventory.json',
          'inventory.json.sha512',
          'v1',
        ]);
        assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, `0=ocfl_object_${ocflVersion}`), 'utf8'), `ocfl_object_${ocflVersion}\n`);

        const text = await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8');
        const digest = sha512('test');
        assert.deepStrictEqual(JSON.parse(text), {
          id: 'made',
          type: `https://ocfl.io/${ocflVersion}/spec/#inventory`,
          digestAlgorithm: 'sha512',
          head: 'v1',
          contentDirectory: 'content',
          manifest: { [digest]: ['v1/content/test.txt'] },
          versions: {
            v1: {
              created: object.head.created.toISOString(),
              message: 'test commit',
              user: { name: 'john', address: 'mailto:john@test.com' },
              state: { [digest]: ['test.txt'] },
            },
          },
        });
        assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, 'inventory.json.sha512'), 'utf8'), `${sha512(text)} inventory.json`);
        assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, 'v1', 'inventory.json'), 'utf8'), text);
        assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, 'v1', 'inventory.json.sha512'), 'utf8'), `${sha512(text)} inventory.json`);
        assert.strictEqual(await fs.promises.readFile(path.join(objectRoot, 'v1', 'content', 'test.txt'), 'utf8'), 'test');
      });
    }
  });

  describe('where it cannot be created', () => {
    /** Asserts that `create` rejects as `expected` without running its callback or changing the storage root */
    async function assertRefused(root: StorageRoot, id: string, expected: Parameters<typeof assert.rejects>[1]) {
      const before = await snapshot(root.path);
      let called = false;
      const build = async (draft: Draft) => {
        called = true;
        await draft.write('a.txt', 'new');
      };
      await assert.rejects(root.create(id, DETAILS, build), expected);
      assert.ok(!called, 'the callback ran');
      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(workspaceOf(root)));
    }

    it('throws OBJECT_EXISTS for an id that already has an object', async () => {
      const root = await newRoot();
      await createObject(root, 'taken', { 'a.txt': 'one' });
      await assertRefused(root, 'taken', ocflError('OBJECT_EXISTS'));
      assert.deepStrictEqual(await textFiles((await root.open('taken')).head), { 'a.txt': 'one' });
    });

    it('throws OBJECT_EXISTS where there is an object declaration but no inventory', async () => {
      const root = await newRoot();
      await writeFiles(objectRootOf(root, 'declared'), { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
      await assertRefused(root, 'declared', ocflError('OBJECT_EXISTS'));
    });

    it('throws OBJECT_EXISTS where there is an inventory but no object declaration', async () => {
      const root = await newRoot();
      await writeFiles(objectRootOf(root, 'undeclared'), { 'inventory.json': 'not an inventory' });
      await assertRefused(root, 'undeclared', ocflError('OBJECT_EXISTS'));
    });

    it('throws OBJECT_EXISTS where there is an object with another id', async () => {
      const root = await newRoot();
      await createObject(root, 'original', { 'a.txt': 'one' });
      await fs.promises.rename(objectRootOf(root, 'original'), objectRootOf(root, 'moved'));
      await assertRefused(root, 'moved', ocflError('OBJECT_EXISTS'));
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT for a directory that holds something else', async () => {
      const root = await newRoot();
      await writeFiles(objectRootOf(root, 'not-empty'), { 'stray.txt': 'x' });
      await assertRefused(root, 'not-empty', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT where there is a file', async () => {
      const root = await newRoot();
      await writeFiles(root.path, { 'a-file': 'x' });
      await assertRefused(root, 'a-file', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT for a place inside another object', async () => {
      const nesting = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      await createObject(nesting, 'outer', { 'a.txt': 'one' });
      await assertRefused(nesting, 'outer/inner', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
      await assertRefused(nesting, 'outer/deep/inner', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
      assert.deepStrictEqual(await textFiles((await nesting.open('outer')).head), { 'a.txt': 'one' });
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT for an id the layout cannot place', async () => {
      const root = await newRoot();
      await assertRefused(root, 'has/a/slash', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
      await assertRefused(root, 'extensions', ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
    });

    it('passes on the file system error when the place of the id cannot be read', async () => {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, 'unreadable');
      await fs.promises.mkdir(objectRoot);
      await withFsFailure('opendir', objectRoot, () => assertRefused(root, 'unreadable', { code: 'EACCES' }), 'EACCES');
      assert.deepStrictEqual(await fs.promises.readdir(objectRoot), []);
    });

    for (const [name, id] of [
      ['a missing id', undefined],
      ['an empty id', ''],
    ] as const) {
      it(`throws a TypeError for ${name}`, async () => {
        const root = await newRoot();
        await assertRefused(root, id as never, TypeError);
      });
    }

    for (const [name, details] of [
      ['no details', undefined],
      ['a missing message', { user: { name: 'Alice' } }],
      ['an empty message', { message: '', user: { name: 'Alice' } }],
      ['a message that is not a string', { message: 42, user: { name: 'Alice' } }],
      ['a missing user', { message: 'Initial deposit' }],
      ['a user with no name', { message: 'Initial deposit', user: { address: 'mailto:alice@example.org' } }],
      ['a user with an empty name', { message: 'Initial deposit', user: { name: '' } }],
      ['a user whose address is not a string', { message: 'Initial deposit', user: { name: 'Alice', address: 42 } }],
    ] as const) {
      it(`throws a TypeError for ${name}, writing nothing`, async () => {
        const root = await newRoot();
        const before = await snapshot(root.path);
        let called = false;
        const build = async () => {
          called = true;
        };
        await assert.rejects(root.create('undescribed', details as never, build), TypeError);
        assert.ok(!called, 'the callback ran');
        assert.deepStrictEqual(await snapshot(root.path), before);
        assert.ok(!fs.existsSync(objectRootOf(root, 'undescribed')));
        await assert.rejects(root.open('undescribed'), ocflError('OBJECT_NOT_FOUND'));
      });
    }
  });
});
