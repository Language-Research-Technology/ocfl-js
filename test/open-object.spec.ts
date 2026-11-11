import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStorageRoot, type LayoutConfig, type OcflError, openStorageRoot, type StorageRoot, type ValidationError } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import {
  rewriteInventory,
  SPEC_EX_FULL_ID,
  STORAGE_FIXTURE,
  writeFiles,
  writeInventory,
  writeSpecExFullRoot,
  writeStorageRoot,
  writeVersions,
} from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';
import { DIGESTS_OF_ABC } from './shared/digests-of-abc.ts';

const FLAT: LayoutConfig = { extensionName: '0002-flat-direct-storage-layout' };

describe('opening an object', () => {
  let tempdir: string;
  let rootCount = 0;
  const newRoot = (layout: LayoutConfig = FLAT) => createStorageRoot(path.join(tempdir, `root-${rootCount++}`), { layout });

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-open-object-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('opens an object by its id', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);
    const object = await root.open('http://example.org/minimal_no_content');
    assert.strictEqual(object.id, 'http://example.org/minimal_no_content');
    assert.strictEqual(object.ocflVersion, '1.1');
    assert.strictEqual(object.digestAlgorithm, 'sha512');
    assert.strictEqual(object.head.number, 1);
    assert.strictEqual(object.head.files.size, 0);
  });

  it('opens an object in a storage root with a hashed layout', async () => {
    const root = await newRoot({ extensionName: HASHED });
    await writeVersions(root.path, 'http://example.org/hashed', [{ 'a.txt': 'abc' }]);
    const object = await root.open('http://example.org/hashed');
    assert.strictEqual(object.id, 'http://example.org/hashed');
    assert.deepStrictEqual([...object.head.files.keys()], ['a.txt']);
  });

  it('requires an id', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);
    await assert.rejects(root.open(''), TypeError);
    await assert.rejects(root.open(undefined as never), TypeError);
  });

  it('cannot have its properties changed', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);
    const object = await root.open('http://example.org/minimal_no_content');
    assert.ok(Object.isFrozen(object));
    assert.ok(Object.isFrozen(object.head));
    assert.ok(Object.isFrozen(object.head.user));
  });

  it('shows nothing of where it is stored', async () => {
    const root = await openStorageRoot(STORAGE_FIXTURE);
    const object = await root.open('http://example.org/minimal_no_content');
    assert.deepStrictEqual(Object.keys(object).sort(), ['digestAlgorithm', 'head', 'id', 'ocflVersion', 'versions']);
    assert.ok(!JSON.stringify(object).includes(root.path));
  });

  it('does not change when a later version is committed, and shows the new version when opened again', async () => {
    const root = await newRoot();
    await writeVersions(root.path, 'unchanging', [{ 'a.txt': 'one' }]);
    const object = await root.open('unchanging');
    await writeVersions(root.path, 'unchanging', [{ 'a.txt': 'two', 'b.txt': 'new' }]);
    assert.deepStrictEqual([...object.versions.keys()], [1]);
    assert.strictEqual(object.head.number, 1);
    assert.deepStrictEqual([...object.head.files.keys()], ['a.txt']);
    assert.strictEqual(await object.head.files.get('a.txt')!.text(), 'one');

    const reopened = await root.open('unchanging');
    assert.deepStrictEqual([...reopened.versions.keys()], [1, 2]);
    assert.strictEqual(reopened.head.number, 2);
    assert.strictEqual(await reopened.head.files.get('a.txt')!.text(), 'two');
  });

  describe('versions', () => {
    let root: StorageRoot;
    before(async () => {
      const rootPath = path.join(tempdir, 'spec-ex-full-root');
      await writeSpecExFullRoot(rootPath);
      root = await openStorageRoot(rootPath);
    });

    it('lists every version by its number, oldest first', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      assert.deepStrictEqual([...object.versions.keys()], [1, 2, 3]);
      assert.deepStrictEqual(
        [...object.versions.values()].map((version) => version.number),
        [1, 2, 3],
      );
    });

    it('has the latest version as its head', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      assert.strictEqual(object.head, object.versions.get(3));
    });

    it('has no version for a number that does not exist', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      assert.strictEqual(object.versions.get(9), undefined);
      assert.strictEqual(object.versions.get(0), undefined);
    });

    it('gives when each version was created as a Date', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      const created = object.versions.get(2)!.created;
      assert.ok(created instanceof Date);
      assert.strictEqual(created.toISOString(), '2018-02-02T02:02:02.000Z');
    });

    it('gives the message and user each version recorded', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      const version = object.versions.get(1)!;
      assert.strictEqual(version.message, 'Initial import');
      assert.deepStrictEqual(version.user, { name: 'Alice', address: 'mailto:alice@example.com' });
    });

    it('lists the files of each version by logical path', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      const paths = (number: number) => [...object.versions.get(number)!.files.keys()].sort();
      assert.deepStrictEqual(paths(1), ['empty.txt', 'foo/bar.xml', 'image.tiff']);
      assert.deepStrictEqual(paths(2), ['empty.txt', 'empty2.txt', 'foo/bar.xml']);
      assert.deepStrictEqual(paths(3), ['empty2.txt', 'foo/bar.xml', 'image.tiff']);
    });

    it('gives each file its logical path and its digest in the algorithm of the object', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      const file = object.head.files.get('foo/bar.xml')!;
      assert.strictEqual(file.path, 'foo/bar.xml');
      assert.strictEqual(
        file.digest,
        '4d27c86b026ff709b02b05d126cfef7ec3aed5f83f5e98df7d7592f7a44bd1dc7f29509cff06b884158baa36a2bbeda11ab8a64b56585a70f5ce1fa96e26eb53',
      );
      assert.strictEqual(
        file.digest,
        createHash(object.digestAlgorithm)
          .update(await file.bytes())
          .digest('hex'),
      );
    });

    it('gives the same files each time they are asked for', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      assert.strictEqual(object.head.files, object.head.files);
      assert.strictEqual(object.head.files.get('foo/bar.xml'), object.versions.get(3)!.files.get('foo/bar.xml'));
    });

    it('has no file for a logical path the version does not have', async () => {
      const object = await root.open(SPEC_EX_FULL_ID);
      assert.strictEqual(object.head.files.get('empty.txt'), undefined);
      assert.strictEqual(object.head.files.get('v1/content/empty.txt'), undefined);
    });
  });

  it('has no message or user for a version that recorded none', async () => {
    const root = await newRoot();
    const objectRoot = await writeVersions(root.path, 'anonymous', [{ 'a.txt': 'abc' }]);
    await rewriteInventory(objectRoot, (inventory) => {
      delete inventory.versions!.v1!.message;
      delete inventory.versions!.v1!.user;
    });
    const { head } = await root.open('anonymous');
    assert.ok(!('message' in head));
    assert.ok(!('user' in head));
  });

  it('has no address for a user recorded without one', async () => {
    const root = await newRoot();
    const objectRoot = await writeVersions(root.path, 'no-address', [{ 'a.txt': 'abc' }]);
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.versions!.v1!.user = { name: 'Alice' };
    });
    assert.deepStrictEqual((await root.open('no-address')).head.user, { name: 'Alice' });
  });

  it('numbers versions whose names are zero-padded', async () => {
    const root = await newRoot();
    const objectRoot = await writeVersions(root.path, 'padded', [{ 'a.txt': 'abc' }]);
    await fs.promises.rename(path.join(objectRoot, 'v1'), path.join(objectRoot, 'v0001'));
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.versions = { v0001: inventory.versions!.v1! };
      inventory.head = 'v0001';
      inventory.manifest = { [DIGESTS_OF_ABC.sha512]: ['v0001/content/a.txt'] };
    });
    const object = await root.open('padded');
    assert.deepStrictEqual([...object.versions.keys()], [1]);
    assert.strictEqual(await object.head.files.get('a.txt')!.text(), 'abc');
  });

  it('opens an object whose inventory uses sha256', async () => {
    const root = await newRoot();
    await writeVersions(root.path, 'sha256-object', [{ 'a.txt': 'abc' }], { digestAlgorithm: 'sha256' });
    const object = await root.open('sha256-object');
    assert.strictEqual(object.digestAlgorithm, 'sha256');
    const file = object.head.files.get('a.txt')!;
    assert.strictEqual(file.digest, DIGESTS_OF_ABC.sha256);
    assert.strictEqual(await file.text(), 'abc');
  });

  describe('OCFL version', () => {
    it('reports 1.1 for an object written in a 1.1 storage root', async () => {
      const root = await newRoot();
      await writeVersions(root.path, 'object-1.1', [{ 'a.txt': 'abc' }]);
      assert.strictEqual((await root.open('object-1.1')).ocflVersion, '1.1');
    });

    it('opens a 1.0 object in a 1.1 storage root and reports 1.0', async () => {
      const rootPath = path.join(tempdir, 'root-1.1-object-1.0');
      await writeStorageRoot(rootPath, '1.0');
      await writeVersions(rootPath, 'http://example.org/object-1.0', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(rootPath, '0=ocfl_1.0'));
      await writeFiles(rootPath, { '0=ocfl_1.1': 'ocfl_1.1\n' });

      const root = await openStorageRoot(rootPath);
      const object = await root.open('http://example.org/object-1.0');
      assert.strictEqual(root.ocflVersion, '1.1');
      assert.strictEqual(object.ocflVersion, '1.0');
      assert.strictEqual(await object.head.files.get('a.txt')!.text(), 'abc');
    });
  });

  describe('an id with no object', () => {
    it('throws OBJECT_NOT_FOUND when nothing is at the place of the id', async () => {
      const root = await newRoot();
      await assert.rejects(root.open('missing'), ocflError('OBJECT_NOT_FOUND'));
      await assert.rejects((await newRoot({ extensionName: HASHED })).open('missing'), ocflError('OBJECT_NOT_FOUND'));
    });

    it('throws OBJECT_NOT_FOUND for a directory with no inventory', async () => {
      const root = await newRoot();
      await fs.promises.mkdir(path.join(root.path, 'empty'));
      await writeFiles(path.join(root.path, 'stray'), { 'notes.txt': 'not an object' });
      await assert.rejects(root.open('empty'), ocflError('OBJECT_NOT_FOUND'));
      await assert.rejects(root.open('stray'), ocflError('OBJECT_NOT_FOUND'));
    });

    it('throws OBJECT_NOT_FOUND when the place of the id is a file, or below one', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      await writeFiles(root.path, { 'a-file': 'not an object' });
      await assert.rejects(root.open('a-file'), ocflError('OBJECT_NOT_FOUND'));
      await assert.rejects(root.open('a-file/below'), ocflError('OBJECT_NOT_FOUND'));
    });

    it('throws OBJECT_NOT_FOUND for an id too long to be the name of a directory', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT });
      await assert.rejects(root.open('x'.repeat(300)), ocflError('OBJECT_NOT_FOUND'));
    });
  });

  describe('a damaged object', () => {
    let root: StorageRoot;
    before(async () => {
      root = await newRoot();
    });

    /** A one-file object whose inventory, and matching sidecar, is rewritten by `corrupt` */
    const damaged = async (id: string, corrupt: Parameters<typeof rewriteInventory>[1]) => {
      const objectRoot = await writeVersions(root.path, id, [{ 'a.txt': 'abc' }]);
      await rewriteInventory(objectRoot, corrupt);
    };
    const invalid = (ocflCode?: string) => (error: OcflError) =>
      ocflError('INVALID_OBJECT', ocflCode)(error) && (ocflCode !== undefined || error.ocflCode === undefined);

    const corruptions: [problem: string, ocflCode: string, corrupt: Parameters<typeof rewriteInventory>[1]][] = [
      [
        'a head that is not one of its versions',
        'E040',
        (inventory) => {
          inventory.head = 'v2';
        },
      ],
      [
        'an empty head',
        'E040',
        (inventory) => {
          inventory.head = '';
        },
      ],
      [
        'no head',
        'E036',
        (inventory) => {
          delete inventory.head;
        },
      ],
      [
        'no id',
        'E036',
        (inventory) => {
          delete inventory.id;
        },
      ],
      [
        'no versions',
        'E040',
        (inventory) => {
          delete inventory.versions;
        },
      ],
      [
        'a state digest that is not in the manifest',
        'E050',
        (inventory) => {
          inventory.manifest = {};
        },
      ],
      [
        'a head that is not a string',
        'E040',
        (inventory) => {
          inventory.head = ['v1'] as never;
        },
      ],
      [
        'a head that is not its latest version',
        'E040',
        (inventory) => {
          inventory.versions!.v2 = inventory.versions!.v1!;
        },
      ],
      [
        'a created time that is not a date',
        'E049',
        (inventory) => {
          inventory.versions!.v1!.created = 'yesterday';
        },
      ],
      [
        'a created time that is a number',
        'E049',
        (inventory) => {
          inventory.versions!.v1!.created = 12 as never;
        },
      ],
      ...(
        [
          ['E099', '../../outside'],
          ['E099', 'v1/content/../../../outside'],
          ['E099', 'v1/./content/a.txt'],
          ['E099', 'v1/content//a.txt'],
          ['E100', '/etc/passwd'],
          ['E100', 'v1/content/a.txt/'],
        ] as const
      ).map(([ocflCode, contentPath]): (typeof corruptions)[number] => [
        `the content path ${contentPath}`,
        ocflCode,
        (inventory) => {
          inventory.manifest = { [DIGESTS_OF_ABC.sha512]: [contentPath] };
        },
      ]),
      ...(
        [
          ['E017', 'a/b'],
          ['E018', '.'],
          ['E018', '..'],
        ] as const
      ).map(([ocflCode, contentDirectory]): (typeof corruptions)[number] => [
        `the contentDirectory ${contentDirectory}`,
        ocflCode,
        (inventory) => {
          inventory.contentDirectory = contentDirectory;
        },
      ]),
      ...['../v1', 'v0', 'v1a', '1'].map((name): (typeof corruptions)[number] => [
        `the version name ${name}`,
        'E104',
        (inventory) => {
          inventory.versions = { [name]: inventory.versions!.v1! };
          inventory.head = name;
        },
      ]),
    ];

    for (const [index, [problem, ocflCode, corrupt]] of corruptions.entries()) {
      it(`throws INVALID_OBJECT with ${ocflCode} for an inventory with ${problem}`, async () => {
        await damaged(`corrupt-${index}`, corrupt);
        await assert.rejects(root.open(`corrupt-${index}`), invalid(ocflCode));
      });
    }

    it('keeps the original error as the cause', async () => {
      await damaged('cause', (inventory) => {
        inventory.head = 'v2';
      });
      await assert.rejects(root.open('cause'), (error: OcflError) => {
        const { name, code, detail } = error.cause as ValidationError;
        assert.deepStrictEqual({ name, code, detail }, { name: 'ValidationError', code: 'E040', detail: 'head "v2" is not in versions' });
        return true;
      });
    });

    it('throws INVALID_OBJECT for an inventory with two versions of the same number', async () => {
      await damaged('same-number', (inventory) => {
        inventory.versions!.v01 = inventory.versions!.v1!;
      });
      await assert.rejects(root.open('same-number'), invalid());
    });

    it('throws INVALID_OBJECT with the SyntaxError as its cause for an inventory that is not JSON', async () => {
      const objectRoot = await writeVersions(root.path, 'not-json', [{ 'a.txt': 'abc' }]);
      await writeFiles(objectRoot, { 'inventory.json': '{ "id": ' });
      await assert.rejects(root.open('not-json'), (error: OcflError) => invalid('E033')(error) && error.cause instanceof SyntaxError);
    });

    for (const [name, content] of [
      ['null', 'null'],
      ['a list', '[]'],
      ['a string', '"inventory"'],
      ['an object with no manifest', JSON.stringify({ id: 'x', head: 'v1', digestAlgorithm: 'sha512', versions: {} })],
    ] as const) {
      it(`throws INVALID_OBJECT for an inventory that is ${name}`, async () => {
        const id = `shape-${name.replaceAll(' ', '-')}`;
        const objectRoot = await writeVersions(root.path, id, [{ 'a.txt': 'abc' }]);
        await writeInventory(objectRoot, content);
        await assert.rejects(root.open(id), ocflError('INVALID_OBJECT'));
      });
    }

    it('throws INVALID_OBJECT with E058 for an inventory with no sidecar', async () => {
      const objectRoot = await writeVersions(root.path, 'no-sidecar', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, 'inventory.json.sha512'));
      await assert.rejects(root.open('no-sidecar'), invalid('E058'));
    });

    it('throws INVALID_OBJECT with E060 for an inventory whose sidecar digest does not match', async () => {
      const objectRoot = await writeVersions(root.path, 'bad-sidecar', [{ 'a.txt': 'abc' }]);
      await writeFiles(objectRoot, { 'inventory.json.sha512': 'abc inventory.json\n' });
      await assert.rejects(root.open('bad-sidecar'), invalid('E060'));
    });

    it('throws INVALID_OBJECT with E060 for an inventory changed after its sidecar was written', async () => {
      const objectRoot = await writeVersions(root.path, 'tampered', [{ 'a.txt': 'abc' }]);
      const file = path.join(objectRoot, 'inventory.json');
      await fs.promises.writeFile(file, (await fs.promises.readFile(file, 'utf8')).replace('"tampered"', '"tampered" '));
      await assert.rejects(root.open('tampered'), invalid('E060'));
    });

    for (const digestAlgorithm of ['md5', 'SHA512', 'nope', 5]) {
      it(`throws INVALID_OBJECT with E025 for an inventory with the digest algorithm ${digestAlgorithm}`, async () => {
        const id = `algorithm-${digestAlgorithm}`;
        const objectRoot = await writeVersions(root.path, id, [{ 'a.txt': 'abc' }]);
        const file = path.join(objectRoot, 'inventory.json');
        const content = JSON.stringify({ ...JSON.parse(await fs.promises.readFile(file, 'utf8')), digestAlgorithm });
        await writeFiles(objectRoot, { 'inventory.json': content });
        await assert.rejects(root.open(id), invalid('E025'));
      });
    }

    it('throws INVALID_OBJECT with E003 for a directory with an inventory but no object declaration', async () => {
      const objectRoot = await writeVersions(root.path, 'undeclared', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(objectRoot, '0=ocfl_object_1.1'));
      await assert.rejects(root.open('undeclared'), invalid('E003'));
    });

    it('throws INVALID_OBJECT with E007 for an object declaration with the wrong contents', async () => {
      const objectRoot = await writeVersions(root.path, 'misdeclared', [{ 'a.txt': 'abc' }]);
      await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'wrong\n' });
      await assert.rejects(root.open('misdeclared'), invalid('E007'));
    });

    it('throws INVALID_OBJECT with E082 for an object nested inside another object', async () => {
      const nesting = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      const outer = await writeVersions(nesting.path, 'outer', [{ 'a.txt': 'abc' }]);
      const copy = path.join(tempdir, 'outer-copy');
      await fs.promises.cp(outer, copy, { recursive: true });
      await fs.promises.cp(copy, path.join(outer, 'deep', 'inner'), { recursive: true });
      await rewriteInventory(path.join(outer, 'deep', 'inner'), (inventory) => {
        inventory.id = 'outer/deep/inner';
      });
      await assert.rejects(nesting.open('outer/deep/inner'), invalid('E082'));
      assert.strictEqual((await nesting.open('outer')).id, 'outer');
    });

    it('throws OBJECT_NOT_FOUND for an id that would be nested inside another object but has no object', async () => {
      const nesting = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      await writeVersions(nesting.path, 'outer', [{ 'a.txt': 'abc' }]);
      await assert.rejects(nesting.open('outer/inner'), ocflError('OBJECT_NOT_FOUND'));
    });

    it('passes on a file system error from reading the inventory', async () => {
      const objectRoot = await writeVersions(root.path, 'unreadable', [{ 'a.txt': 'abc' }]);
      await withFsFailure(
        'readFile',
        path.join(objectRoot, 'inventory.json'),
        () => assert.rejects(root.open('unreadable'), (error: NodeJS.ErrnoException) => error.code === 'EACCES' && error.name === 'Error'),
        'EACCES',
      );
    });
  });

  describe('an id that does not belong where it maps', () => {
    const incompatible = ocflError('ID_INCOMPATIBLE_WITH_LAYOUT');

    for (const id of ['../x', 'a/../../x', 'a/./b', 'extensions/foo']) {
      it(`throws ID_INCOMPATIBLE_WITH_LAYOUT for the path-direct id ${id}`, async () => {
        const root = await newRoot({ extensionName: PATH_DIRECT });
        await assert.rejects(root.open(id), incompatible);
      });
    }

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT for an id the layout maps into the extensions directory', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      await assert.rejects(root.open('extensions/ocfl-js-workspace/an-object'), incompatible);
      await assert.rejects(root.open('Extensions/an-object'), incompatible);
    });

    it('does not open an object outside the storage root', async () => {
      const parent = path.join(tempdir, 'parent-of-root');
      const root = await createStorageRoot(path.join(parent, 'storage'), { layout: FLAT });
      const outside = await createStorageRoot(path.join(parent, 'outside'), { layout: FLAT });
      await writeVersions(outside.path, 'x', [{ 'a.txt': 'abc' }]);
      await assert.rejects(root.open('../outside/x'), incompatible);
    });

    it('throws ID_INCOMPATIBLE_WITH_LAYOUT when the directory of the id holds an object with another id', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, omitScheme: true });
      await writeVersions(root.path, 'http://example.org/shared', [{ 'a.txt': 'abc' }]);
      await assert.rejects(root.open('https://example.org/shared'), incompatible);
      assert.strictEqual((await root.open('http://example.org/shared')).id, 'http://example.org/shared');
    });
  });
});
