import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
import ocfl, {
  type Inventory,
  ObjectNotFoundError,
  ObjectNotLoadedError,
  type OcflError,
  type OcflObjectTransaction,
  type OcflVersion,
  type WriteFileData,
} from '../../src/index.ts';
import type { OcflObject } from '../../src/object.ts';
import { emptyDirectoriesUnder } from '../empty-directories.ts';
import { withFsFailure } from '../fs-failures.ts';
import { ocflError } from '../ocfl-error.ts';
import { testObject } from '../test-object.ts';

let objcount = 0;
const fixture = path.join(import.meta.dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full');

async function validateFile(object: OcflObject, srcPath: string, logicalPath: string) {
  const content = await fs.promises.readFile(srcPath);
  const digest = createHash('sha512').update(content).digest('hex');
  const inv = (await object.getInventory())!;
  assert.strictEqual(inv.manifest[digest]?.length, 1);
  assert.ok(inv.state[digest]!.includes(logicalPath));
  assert.strictEqual(content.toString(), await object.getFile({ digest })!.text());
  assert.strictEqual(content.toString(), await object.getFile({ logicalPath })!.text());
}

before(() => {});

// describe("object encapsulation", function () {
//   it("cannot access protected properties", function () {
//     assert.equal(object._getInventory, null);
//   });
// });

describe('constructor', () => {
  it('can create new object', () => {
    let object: OcflObject;
    object = testObject({ root: '/data/objects/object-1' });
    assert.equal(object.root, '/data/objects/object-1');
    object = testObject({ root: '/data/objects/object-1', digestAlgorithm: 'sha256', id: 'object-1' });
    assert.equal(object.root, '/data/objects/object-1');
    assert.equal(object.id, 'object-1');
  });
});

describe('access existing object', () => {
  let invRaw: Inventory, invRawFiles: string[];
  let object = testObject({ root: '/tmp/dummy' });

  before(async () => {
    const config = { root: path.join(import.meta.dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full') };
    object = testObject(config);
    invRaw = JSON.parse(await fs.promises.readFile(path.join(config.root, 'inventory.json'), 'utf8'));
    invRawFiles = Object.values(invRaw.versions[invRaw.head]!.state).flat();
  });

  it('can read inventory', async () => {
    const inv = (await object.getInventory())!;
    assert.deepStrictEqual(object.id, invRaw.id);
    assert.strictEqual(inv.toString(), JSON.stringify(invRaw, null, 2));
    const files = [];
    for (const f of inv.files()) {
      files.push(f.logicalPath);
    }
    assert.deepStrictEqual(files, invRawFiles);
  });

  it('can list files', async () => {
    const files = [...(await object.files())].map((f) => f.logicalPath);
    assert.deepStrictEqual(files, invRawFiles);
  });
  //todo: list non existant object
  it('can list files with metadata', async () => {
    await object.load({ filesMetadata: true });
    const { manifest } = invRaw;
    for await (const f of await object.files()) {
      const s = await fs.promises.stat(path.join(object.root, f.contentPath!));
      assert.ok(manifest[f.digest!]!.includes(f.contentPath!));
      assert.strictEqual(f.size, s.size);
      assert.strictEqual(f.lastModified, s.mtime.getTime());
    }
  });

  it('can stat a file', async () => {
    const actualStat = await fs.promises.stat(path.join(object.root, 'v2/content/foo/bar.xml'));
    const stat = await object.getFile('foo/bar.xml')!.stat();
    assert.equal(stat.size, actualStat.size);
    assert.equal(stat.mtime!.valueOf(), actualStat.mtime.valueOf());
  });
  it('can read a file as string', async () => {
    const actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'), 'utf8');
    const content = await object.getFile('foo/bar.xml')!.text();
    assert.equal(content, actualContent);
  });
  it('can read a file as buffer', async () => {
    const actualContent = await fs.promises.readFile(path.join(object.root, 'v1/content/image.tiff'));
    const content = await object.getFile('image.tiff')!.buffer();
    assert.equal(Buffer.compare(content, actualContent), 0);
  });
  it('can read a file as web stream', async () => {
    const actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'));
    const stream = await object.getFile('foo/bar.xml')!.stream();
    const buffers = [];
    for await (const data of stream) {
      buffers.push(data);
    }
    const content = Buffer.concat(buffers);
    assert.equal(content.compare(actualContent), 0);
  });
});

describe('update', () => {
  const datadir = path.join(import.meta.dirname, 'test-data');
  let tempdir: string;
  let objectx: OcflObject;

  function createObject(id: string, ocflVersion?: OcflVersion) {
    return testObject({ id, root: path.join(tempdir, id), ocflVersion });
  }

  async function readInventory(object: OcflObject): Promise<Inventory> {
    return JSON.parse(await fs.promises.readFile(path.join(object.root, 'inventory.json'), 'utf8'));
  }

  const sha512 = (content: string | Uint8Array) => createHash('sha512').update(content).digest('hex');
  const encode = (text: string) => new TextEncoder().encode(text);
  const streamOf = (content: string) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(encode(content));
        controller.close();
      },
    });

  async function contentFiles(o: OcflObject, version: string) {
    const dir = path.join(o.root, version);
    const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !/^inventory\.json/.test(e.name))
      .map((e) => path.relative(o.root, path.join(e.parentPath, e.name)))
      .sort();
  }

  /** Every file in `version` is in the manifest, and every manifest path is on disk */
  async function assertManifestMatchesFiles(o: OcflObject, version = 'v1') {
    const inventory = await readInventory(o);
    const manifested = Object.values(inventory.manifest)
      .flat()
      .filter((p) => p.startsWith(`${version}/`))
      .sort();
    assert.deepStrictEqual(await contentFiles(o, version), manifested);
    return inventory;
  }

  async function assertReads(o: OcflObject, expected: Record<string, string>) {
    const reloaded = testObject({ root: o.root });
    await reloaded.load();
    for (const [logicalPath, content] of Object.entries(expected)) {
      assert.strictEqual(await reloaded.getFile(logicalPath)!.text(), content, logicalPath);
    }
    const inventory = await readInventory(o);
    assert.deepStrictEqual(Object.values(inventory.versions[inventory.head]!.state).flat().sort(), Object.keys(expected).sort());
  }

  async function assertNoEmptyDirectories(o: OcflObject, version: string) {
    assert.deepStrictEqual(await emptyDirectoriesUnder(path.join(o.root, version)), []);
  }

  /** The invariants the version must meet at commit */
  async function assertValid(o: OcflObject, version: string, expected: Record<string, string>) {
    const inventory = await assertManifestMatchesFiles(o, version);
    await assertNoEmptyDirectories(o, version);
    const usedDigests = new Set(Object.values(inventory.versions).flatMap((v) => Object.keys(v.state)));
    const contentPaths = Object.values(inventory.manifest).flat();
    assert.strictEqual(new Set(contentPaths).size, contentPaths.length, 'a content path appears under two digests');
    for (const [digest, paths] of Object.entries(inventory.manifest)) {
      assert.ok(usedDigests.has(digest), `${digest} is in the manifest but no version state uses it`);
      for (const contentPath of paths) {
        assert.strictEqual(sha512(await fs.promises.readFile(path.join(o.root, contentPath))), digest, contentPath);
      }
    }
    await assertReads(o, expected);
    return inventory;
  }

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-object-'));
    objectx = createObject('object-x');
  });

  it('can detect error of unfinished operations', async () => {
    let ow = createObject('object-we1');
    await ow.update(async (t) => t.write('a.txt', 'a'));
    // @ts-expect-error deliberately not async
    const p1 = ow.update((t) => {
      t.write('test.txt', 'test');
    });
    await assert.rejects(p1);
    ow = createObject('object-we2');
    const p2 = ow.update(async (t) => {
      // wrong, must use await or return as a promise
      t.write('test.txt', 'test');
    });
    await assert.rejects(p2);
  });

  it('can clean up after error', async () => {
    const o = createObject('object-we3');
    await assert.rejects(fs.promises.access(o._workspace));
    try {
      await o.update(async (t) => {
        await t.write('test.txt', 'test');
        await fs.promises.access(o._workspace);
        throw new Error('test');
      });
    } catch {}
    await assert.rejects(fs.promises.access(o._workspace));
    await assert.rejects(fs.promises.access(o.root));
  });

  it('does not allow nested objects', async () => {
    const o = createObject('object-we4');
    await o.update(async (t) => {
      await t.write('test.txt', 'test');
    });
    assert.strictEqual(await fs.promises.readFile(path.join(o.root, 'v1/content/test.txt'), 'utf8'), 'test');
    const o1 = createObject('object-we4/object-we5');
    const o2 = createObject('object-we4/test/object-we5');
    await assert.rejects(o1.update(async (t) => t.write('test.txt', 'test')));
    await assert.rejects(o2.update(async (t) => t.write('test.txt', 'test')));
  });

  for (const ocflVersion of ocfl.OCFL_VERSIONS) {
    it(`can create correct namaste and inventory, with version ${ocflVersion}`, async () => {
      objcount++;
      const o = createObject(`object-${objcount}`, ocflVersion);
      const content = 'test';
      const commitInfo = { message: 'test commit', user: { name: 'john', address: 'john@test.com' } };
      const hash = createHash('sha512').update(content).digest('hex');

      await o.update(async (t) => {
        await t.write('test.txt', content);
        await t.commit(commitInfo);
      });
      const inventory = (await o.getInventory())!;
      // namaste
      assert.strictEqual(`ocfl_object_${ocflVersion}\n`, await fs.promises.readFile(path.join(o.root, `0=ocfl_object_${ocflVersion}`), 'utf8'));
      // inventory
      const invstr = await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8');
      const inv = JSON.parse(invstr);
      //assert.strictEqual(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'), inventory.toString());
      assert.strictEqual(inv.id, `object-${objcount}`);
      assert.strictEqual(inv.digestAlgorithm, 'sha512');
      assert.strictEqual(inv.type, `https://ocfl.io/${ocflVersion}/spec/#inventory`);
      assert.strictEqual(inv.head, 'v1');
      assert.strictEqual(inv.manifest[hash][0], 'v1/content/test.txt');
      assert.strictEqual(inv.versions.v1.created, inventory.created);
      assert.strictEqual(inv.versions.v1.message, inventory.message);
      assert.strictEqual(inv.versions.v1.user.name, inventory.user?.name);
      assert.strictEqual(inv.versions.v1.state[hash][0], 'test.txt');
      // sidecar
      const sidecar = await fs.promises.readFile(path.join(o.root, 'inventory.json.sha512'), 'utf8');
      const invhash = createHash('sha512').update(invstr).digest('hex');

      assert.strictEqual(sidecar, `${invhash} inventory.json`);

      //await fs.promises.rm(o.root, { recursive: true, force: true });
    });
  }

  it('can write string, buffer, and stream to file', async () => {
    const content = await fs.promises.readFile(path.join(datadir, 'test_input.txt'));
    await objectx.update(async (t) => {
      // text
      await t.write('test.txt', content.toString());
      // buffer
      await t.write('a/test.txt', content);
      // stream
      await t.write('b/test.txt', Readable.toWeb(fs.createReadStream(path.join(datadir, 'test_input.txt'))));
    });
    const hash = createHash('sha512').update(content).digest('hex');
    // inventory
    const inv = JSON.parse(await fs.promises.readFile(path.join(objectx.root, 'inventory.json'), 'utf8'));
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest[hash][0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest[hash].length, 1);

    // content
    assert.strictEqual(content.toString(), await fs.promises.readFile(path.join(objectx.root, 'v1/content/test.txt'), 'utf8'));
    await assert.rejects(fs.promises.readFile(path.join(objectx.root, 'v1/content/a/test.txt'), 'utf8'));
    await assert.rejects(fs.promises.readFile(path.join(objectx.root, 'v1/content/b/test.txt'), 'utf8'));
  });

  it('can import and copy files', async () => {
    const f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-minimal/v1/file.txt');
    const f2 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
    await objectx.update(async (t) => {
      // file
      await assert.rejects(t.import(f1, '')); // target path cannot be empty string
      await t.import(f1);
      // directory
      await t.import(f2);
      await t.copy('foo', 'foo2');
    });
    const inv = JSON.parse(await fs.promises.readFile(path.join(objectx.root, 'inventory.json'), 'utf8'));
    assert.strictEqual(inv.head, 'v2');
    await validateFile(objectx, f1, 'file.txt');
    await validateFile(objectx, path.join(f2, 'foo/bar.xml'), 'foo/bar.xml');
    await validateFile(objectx, path.join(f2, 'foo/bar.xml'), 'foo2/bar.xml');
    await validateFile(objectx, path.join(f2, 'empty2.txt'), 'empty2.txt');
    await validateFile(objectx, path.join(f2, 'image.tiff'), 'image.tiff');
  });

  it('can rename files', async () => {
    let inv = (await objectx.getInventory())!;
    const d1 = inv.getDigest('empty2.txt');
    const d2 = inv.getDigest('foo2/bar.xml');
    await objectx.update(async (t) => {
      // file
      await t.rename('empty2.txt', 'empty.txt');
      // directory
      await t.rename('foo2', 'bar');
    });
    inv = (await objectx.getInventory())!;
    assert.strictEqual(inv.head, 'v3');
    assert.strictEqual(d1, inv.getDigest('empty.txt'));
    assert.strictEqual(d2, inv.getDigest('bar/bar.xml'));
    assert.ok(!inv.getDigest('empty2.txt'));
    assert.ok(!inv.getDigest('foo2/bar.xml'));
  });

  it('can remove files', async () => {
    const c1 = await objectx.count();
    await objectx.update(async (t) => {
      // file
      await t.remove('test.txt');
      // directory
      await t.remove('bar');
    });
    const c2 = await objectx.count();
    const inv = (await objectx.getInventory())!;
    assert.strictEqual(inv.head, 'v4');
    assert.strictEqual(c2, c1 - 2);
    await assert(!objectx.getFile('test.txt'));
    await assert(!objectx.getFile('bar/bar.xml'));
  });

  it('can reinstate files', async () => {
    await objectx.update(async (t) => {
      // file
      await t.reinstate('test.txt', 3);
      // directory
      await t.reinstate('bar', 3);
    });
    //console.log([...(await objectx.files())].map(f => f.logicalPath));
    const inv = (await objectx.getInventory())!;
    const d1 = inv.getDigest('test.txt', 'v3');
    const d2 = inv.getDigest('bar/bar.xml', 'v3');
    assert.strictEqual(inv.head, 'v5');
    assert.strictEqual(inv.getDigest('test.txt'), d1);
    assert.strictEqual(inv.getDigest('bar/bar.xml'), d2);
    await validateFile(objectx, path.join(datadir, 'test_input.txt'), 'test.txt');
    await validateFile(objectx, path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3/foo/bar.xml'), 'bar/bar.xml');
  });

  it('can update using replace mode', async () => {
    await objectx.update(
      async (t) => {
        await t.import(path.join(datadir, 'test_input.txt'));
        await t.import(path.join(datadir, 'sample_dir'), 'sample_dir');
      },
      { mode: 'REPLACE' },
    );
    const inv = (await objectx.getInventory())!;
    assert.strictEqual(inv.head, 'v6');
    const files = [...(await objectx.files())].map((f) => f.logicalPath).sort();
    assert.deepStrictEqual(files, ['test_input.txt', 'sample_dir/data1', 'sample_dir/data2'].sort());
    await assert.doesNotReject(fs.promises.access(path.join(objectx.root, 'v6')));
  });

  it('should only add actual file content if it does not exist', async () => {
    await objectx.update(async (t) => {
      await t.import(path.join(datadir, 'test_input.txt'));
      await t.import(path.join(datadir, 'test_input.txt'), 'test2.txt');
    });
    const inv = (await objectx.getInventory())!;
    assert.strictEqual(inv.head, 'v7');
    await assert.doesNotReject(fs.promises.access(path.join(objectx.root, 'v1/content/test.txt')));
    await assert.rejects(fs.promises.access(path.join(objectx.root, 'v7/content/test_input.txt')));
    await assert.rejects(fs.promises.access(path.join(objectx.root, 'v7/content/test2.txt')));
  });

  it('should only create new version if there is actual changes', async () => {
    await objectx.update(async (t) => {
      await t.import(path.join(datadir, 'test_input.txt'));
    });
    const inv = (await objectx.getInventory())!;
    assert.strictEqual(inv.head, 'v7');
    await assert.rejects(fs.promises.access(path.join(objectx.root, 'v8')));
  });

  it('can correctly create versions', async () => {
    const o = createObject('object-version-1');
    let c: string;
    await o.update(async (t) => {
      await t.write('test', 'test');
    });
    c = await fs.promises.readFile(path.join(o.root, 'v1/content/test'), 'utf8');
    assert.strictEqual(c, 'test');
    assert.strictEqual(await o.getFile('test')!.text(), 'test');
    await o.update(async (t) => {
      await t.write('test', 'testv2');
    });
    c = await fs.promises.readFile(path.join(o.root, 'v2/content/test'), 'utf8');
    assert.strictEqual(c, 'testv2');
    assert.strictEqual(await o.getFile('test')!.text(), 'testv2');
    await o.update(async (t) => {
      await t.write('test', 'test');
    });
    //console.log(o._inventory.latest.toString());
    //console.log(o._inventory.v3.toString());
    await assert.rejects(fs.promises.readFile(path.join(o.root, 'v3/content/test'), 'utf8'));
    assert.strictEqual(await o.getFile('test')!.text(), 'test');
    await o.update(async (t) => {
      await t.write('test', 'testv4');
    });
    c = await fs.promises.readFile(path.join(o.root, 'v4/content/test'), 'utf8');
    assert.strictEqual(c, 'testv4');
    assert.strictEqual(await o.getFile('test')!.text(), 'testv4');
  });

  it('lists and reads an older version after a later version changed or removed its files', async () => {
    const o = createObject('object-older-version');
    await o.update(async (t) => {
      await t.write('changed.txt', 'original');
      await t.write('removed.txt', 'removed later');
    });
    await o.update(async (t) => {
      await t.write('changed.txt', 'replaced');
      await t.remove('removed.txt');
    });
    const contents = await Promise.all([...(await o.files('v1'))].map(async (f) => [f.logicalPath, await f.text()]));
    assert.deepStrictEqual(Object.fromEntries(contents), { 'changed.txt': 'original', 'removed.txt': 'removed later' });
  });

  it('can add a directory without using transaction directly', async () => {
    const f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
    const o = createObject('object-import-1');
    await o.import(f1);
    const inv = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
    assert.strictEqual(inv.head, 'v1');
    await validateFile(o, path.join(f1, 'foo/bar.xml'), 'foo/bar.xml');
    await validateFile(o, path.join(f1, 'empty2.txt'), 'empty2.txt');
    await validateFile(o, path.join(f1, 'image.tiff'), 'image.tiff');
  });

  it('can add directories without using transaction directly', async () => {
    const f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
    const f2 = path.join(datadir, 'fixtures/1.1/content/spec-ex-diff-paths/v1');
    const o = createObject('object-import-2');
    await o.import([{ source: f1 }, { source: f2 }]);
    const inv = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
    assert.strictEqual(inv.head, 'v1');
    await validateFile(o, path.join(f1, 'foo/bar.xml'), 'foo/bar.xml');
    await validateFile(o, path.join(f1, 'empty2.txt'), 'empty2.txt');
    await validateFile(o, path.join(f1, 'image.tiff'), 'image.tiff');
    await validateFile(o, path.join(f2, 'a file.wxy'), 'a file.wxy');
    await validateFile(o, path.join(f2, 'another file.xyz'), 'another file.xyz');
  });

  //@todo: check delete, rename, reinstate non existant logical path

  describe('fixity block on disk', () => {
    it('is carried forward untouched by an update', async () => {
      const root = path.join(tempdir, 'object-fixity-carried');
      await fs.promises.cp(fixture, root, { recursive: true });
      const source = path.join(tempdir, 'fixity-carried-source.txt');
      await fs.promises.writeFile(source, 'imported');
      const before = await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8');
      const object = testObject({ root });
      await object.update(async (t) => {
        await t.write('new.txt', 'new');
        await t.copy('image.tiff', 'image-copy.tiff');
        await t.write('empty3.txt', await fs.promises.readFile(path.join(root, 'v1/content/empty.txt')));
        await t.import(source, 'imported.txt');
        await t.remove('foo/bar.xml');
      });
      const inventory = await readInventory(object);
      assert.strictEqual(inventory.head, 'v4');
      assert.deepStrictEqual(inventory.fixity, JSON.parse(before).fixity);
      assert.deepStrictEqual(Object.keys(inventory.fixity ?? {}), ['md5', 'sha1']);
    });

    it('is not written for a new object', async () => {
      const object = createObject('object-no-fixity');
      await object.update(async (t) => {
        await t.write('a.txt', 'first');
      });
      assert.ok(!('fixity' in (await readInventory(object))));
    });
  });

  describe('removes only what the update created', () => {
    let scenario = 0;

    function dirs() {
      const base = path.join(tempdir, `scoped-${++scenario}`);
      return { base, root: path.join(base, 'object'), extensions: path.join(base, 'extensions') };
    }

    async function snapshot(dir: string) {
      const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
      const files = entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
      return Object.fromEntries(await Promise.all(files.map(async (f) => [path.relative(dir, f), await fs.promises.readFile(f, 'utf8')])));
    }

    const unfinished = async (t: OcflObjectTransaction) => {
      t.write('floating.txt', 'floating');
    };
    const writeB = (t: OcflObjectTransaction) => t.write('b.txt', 'b');
    type Outcome = [string, (o: OcflObject) => Promise<unknown>];
    const throwing: Outcome[1] = (o) =>
      assert.rejects(
        o.update(async (t) => {
          await writeB(t);
          throw new Error('updater failed');
        }),
        /updater failed/,
      );
    const endings: Outcome[] = [
      ['a throwing updater', throwing],
      ['unfinished operations', (o) => assert.rejects(o.update(unfinished), /Unfinished operations/)],
      [
        'a manual rollback',
        async (o) => {
          const t = (await o.update())!;
          await t.write('b.txt', 'b');
          await t.rollback();
        },
      ],
    ];
    const noOp: Outcome = ['a no-op update', (o) => o.update(async () => {})];
    const emptyCommit: Outcome = [
      'a commit with no changes',
      async (o) => {
        const t = (await o.update())!;
        await t.commit();
      },
    ];

    for (const [name, end] of [...endings, noOp, emptyCommit]) {
      it(`leaves an existing object intact after ${name}`, async () => {
        const { root } = dirs();
        const o = testObject({ id: 'scoped', root });
        await o.update(async (t) => t.write('a.txt', 'a'));
        const before = await snapshot(root);

        await end(o);

        assert.deepStrictEqual(await snapshot(root), before);
        assert.strictEqual(o.headVersion?.toString(), 'v1');
      });
    }

    // An update with no changes commits an empty first version, so it is not a rollback here.
    for (const [name, end] of endings) {
      it(`leaves no partial object after ${name} on a new object`, async () => {
        const { root } = dirs();
        const o = testObject({ id: 'scoped', root });

        await end(o);

        await assert.rejects(fs.promises.access(root), { code: 'ENOENT' });
        await o.update(async (t) => t.write('a.txt', 'a'));
        assert.strictEqual(await o.getFile('a.txt')!.text(), 'a');
      });

      it(`keeps an object root that already existed after ${name}`, async () => {
        const { root } = dirs();
        await fs.promises.mkdir(root, { recursive: true });
        const o = testObject({ id: 'scoped', root });

        await end(o);

        assert.deepStrictEqual(await fs.promises.readdir(root), []);
        await o.update(async (t) => t.write('a.txt', 'a'));
        assert.strictEqual(await o.getFile('a.txt')!.text(), 'a');
      });
    }

    const updateOutcomes: Outcome[] = [
      ['a failed', throwing],
      ['a successful', (o) => o.update(writeB)],
    ];

    for (const [name, update] of updateOutcomes) {
      it(`keeps unrelated workspace content after ${name} update`, async () => {
        const { root } = dirs();
        const o = testObject({ id: 'scoped', root });
        const workspaceRoot = path.dirname(o._workspace);
        await fs.promises.mkdir(workspaceRoot, { recursive: true });
        await fs.promises.writeFile(path.join(workspaceRoot, 'unrelated.txt'), 'keep');

        await update(o);

        assert.deepStrictEqual(await fs.promises.readdir(workspaceRoot), ['unrelated.txt']);
        assert.strictEqual(await fs.promises.readFile(path.join(workspaceRoot, 'unrelated.txt'), 'utf8'), 'keep');
      });

      it(`removes the workspace and extensions directories left empty by ${name} update`, async () => {
        const { root, extensions } = dirs();
        const o = testObject({ id: 'scoped', root });

        await update(o);

        await assert.rejects(fs.promises.access(extensions), { code: 'ENOENT' });
      });
    }

    it('does not disturb another object in progress in the same storage root', async () => {
      const { root, base } = dirs();
      const a = testObject({ id: 'a', root });
      const b = testObject({ id: 'b', root: path.join(base, 'other') });
      await a.update(async (t) => t.write('a.txt', 'a'));

      const inProgress = (await a.update())!;
      await inProgress.write('new.txt', 'new');
      await b.update(async (t) => t.write('b.txt', 'b'));
      await inProgress.commit();

      assert.strictEqual(await a.getFile('new.txt')!.text(), 'new');
      assert.strictEqual(a.headVersion?.toString(), 'v2');
    });

    const assertGone = (dir: string) => assert.rejects(fs.promises.access(dir), { code: 'ENOENT' });

    const commitSteps: {
      step: string;
      method: 'rename' | 'copyFile' | 'writeFile';
      target: (root: string, workingDir: string, version: string) => string;
    }[] = [
      { step: 'writing the version inventory', method: 'writeFile', target: (_, dir, v) => path.join(dir, v, 'inventory.json') },
      { step: 'moving the version into the object', method: 'rename', target: (root, _, v) => path.join(root, v) },
      { step: 'staging the root inventory', method: 'copyFile', target: (root) => path.join(root, 'inventory.json.tmp') },
      { step: 'staging the root inventory sidecar', method: 'copyFile', target: (root) => path.join(root, 'inventory.json.sha512.tmp') },
      { step: 'replacing the root inventory', method: 'rename', target: (root) => path.join(root, 'inventory.json') },
    ];

    for (const { step, method, target } of commitSteps) {
      it(`leaves an existing object intact when ${step} fails`, async () => {
        const { root, extensions } = dirs();
        const o = testObject({ id: 'scoped', root });
        await o.update(async (t) => t.write('a.txt', 'a'));
        const before = await snapshot(root);

        await withFsFailure(method, target(root, o._workspace, 'v2'), () => assert.rejects(o.update(writeB), /injected failure/));

        assert.deepStrictEqual(await snapshot(root), before);
        await assertGone(extensions);
        assert.strictEqual(o.headVersion?.toString(), 'v1');
        await o.update(writeB);
        assert.strictEqual(await o.getFile('b.txt')!.text(), 'b');
      });

      it(`leaves no partial object when ${step} fails on a new object`, async () => {
        const { root, extensions } = dirs();
        const o = testObject({ id: 'scoped', root });

        await withFsFailure(method, target(root, o._workspace, 'v1'), () => assert.rejects(o.update(writeB), /injected failure/));

        await assert.rejects(fs.promises.access(root), { code: 'ENOENT' });
        await assertGone(extensions);
        await o.update(writeB);
        assert.strictEqual(await o.getFile('b.txt')!.text(), 'b');
      });
    }

    it('throws RECOVERY_NEEDED and keeps the new root inventory and the lock when replacing the root inventory sidecar fails', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });
      await o.update(async (t) => t.write('a.txt', 'a'));

      await withFsFailure('rename', path.join(root, 'inventory.json.sha512'), () =>
        assert.rejects(o.update(writeB), (e: OcflError) => e.code === 'RECOVERY_NEEDED' && /injected failure/.test((e.cause as Error).message)),
      );

      assert.strictEqual(JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')).head, 'v2');
      assert.strictEqual(o.headVersion?.toString(), 'v1');
      await assert.rejects(o.update(writeB), { code: 'UPDATE_IN_PROGRESS' });
    });

    it('throws RECOVERY_NEEDED with the updater error as its cause, and keeps the lock, when the update cannot be undone', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });
      const failure = new Error('updater failed');

      await withFsFailure(
        'rm',
        path.join(o._workspace, 'v1'),
        () =>
          assert.rejects(
            o.update(async (t) => {
              await t.write('a.txt', 'a');
              throw failure;
            }),
            (e: OcflError) => e.code === 'RECOVERY_NEEDED' && e.cause === failure,
          ),
        'EACCES',
      );

      await assert.rejects(o.update(writeB), { code: 'UPDATE_IN_PROGRESS' });
    });

    it('throws RECOVERY_NEEDED from rollback(), and keeps the lock, when the update cannot be undone', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });
      const t = (await o.update())!;
      await t.write('a.txt', 'a');

      await withFsFailure(
        'rm',
        path.join(o._workspace, 'v1'),
        () => assert.rejects(t.rollback(), (e: OcflError) => e.code === 'RECOVERY_NEEDED' && /injected failure/.test((e.cause as Error).message)),
        'EACCES',
      );

      await assert.rejects(o.update(writeB), { code: 'UPDATE_IN_PROGRESS' });
    });

    it('keeps a file that only looks like its staged inventory when nothing was staged', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });
      await o.update(async (t) => t.write('a.txt', 'a'));
      await fs.promises.writeFile(path.join(root, 'inventory.json.tmp'), 'not ours');

      await o.update(async () => {});

      assert.strictEqual(await fs.promises.readFile(path.join(root, 'inventory.json.tmp'), 'utf8'), 'not ours');
    });

    it('reports the updater error when the empty workspace cannot be removed', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });

      await withFsFailure('rmdir', o._workspace, () => throwing(o));
    });

    it('keeps the object locked when the only file of the update is removed', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });

      const first = (await o.update())!;
      await first.write('x/a.txt', 'a');
      await first.remove('x/a.txt');
      await assert.rejects(o.update(), { code: 'UPDATE_IN_PROGRESS' });
      await first.rollback();
    });

    it('lets only one concurrent update take the lock', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });
      await o.update(async (t) => t.write('a.txt', 'a'));

      const results = await Promise.allSettled([o.update(), o.update()]);

      const rejected = results.filter((r) => r.status === 'rejected');
      assert.deepStrictEqual(
        rejected.map((r) => r.reason.code),
        ['UPDATE_IN_PROGRESS'],
      );
      const [holder] = results.filter((r) => r.status === 'fulfilled');
      await holder!.value!.rollback();
    });

    it('refuses an out-of-date object with OBJECT_OUT_OF_DATE, leaving no lock', async () => {
      const { root, extensions } = dirs();
      const stale = testObject({ id: 'scoped', root });
      await stale.update(async (t) => t.write('a.txt', 'a'));
      await testObject({ id: 'scoped', root }).update(writeB);

      await assert.rejects(stale.update(writeB), { code: 'OBJECT_OUT_OF_DATE' });

      await assertGone(extensions);
    });

    it('resolves when the committed update cannot remove its empty workspace', async () => {
      const { root } = dirs();
      const o = testObject({ id: 'scoped', root });

      await withFsFailure('rmdir', o._workspace, () => o.update(writeB));

      assert.strictEqual(await o.getFile('b.txt')!.text(), 'b');
      assert.strictEqual(o.headVersion?.toString(), 'v1');
    });
  });

  describe('concurrent operations in one transaction', () => {
    const ROUNDS = 20;
    let scenario = 0;

    const newObject = () => createObject(`concurrent-${++scenario}`);

    for (let round = 0; round < ROUNDS; round++) {
      describe(`round ${round}`, () => {
        it('importing a directory stores duplicate files once, including in subdirectories', async () => {
          const source = path.join(tempdir, `dup-source-${++scenario}`);
          await fs.promises.mkdir(path.join(source, 'sub/deeper'), { recursive: true });
          for (const file of ['a.txt', 'b.txt', 'sub/c.txt', 'sub/deeper/d.txt']) {
            await fs.promises.writeFile(path.join(source, file), 'identical');
          }
          await fs.promises.writeFile(path.join(source, 'sub/other.txt'), 'other');

          const o = newObject();
          await o.update(async (t) => t.import(source));

          const inventory = await assertManifestMatchesFiles(o);
          assert.strictEqual(Object.keys(inventory.manifest).length, 2);
          await assertReads(o, {
            'a.txt': 'identical',
            'b.txt': 'identical',
            'sub/c.txt': 'identical',
            'sub/deeper/d.txt': 'identical',
            'sub/other.txt': 'other',
          });
        });

        const identicalWrites: [string, (t: OcflObjectTransaction, logicalPath: string, index: number) => Promise<void>][] = [
          ['strings', (t, p) => t.write(p, 'same')],
          ['buffers', (t, p) => t.write(p, encode('same'))],
          ['streams', (t, p) => t.write(p, streamOf('same'))],
          ['a mix of strings and streams', (t, p, i) => t.write(p, i % 2 ? streamOf('same') : 'same')],
        ];

        for (const [kind, write] of identicalWrites) {
          it(`concurrent writes of identical ${kind} leave one content file`, async () => {
            const o = newObject();
            const paths = ['a', 'b', 'c', 'd'];
            await o.update(async (t) => {
              await Promise.all(paths.map((p, i) => write(t, p, i)));
            });

            await assertManifestMatchesFiles(o);
            assert.strictEqual((await contentFiles(o, 'v1')).length, 1);
            await assertReads(o, { a: 'same', b: 'same', c: 'same', d: 'same' });
          });
        }

        it('concurrent writes of identical streams to one logical path leave it readable', async () => {
          const o = newObject();
          await o.update(async (t) => {
            await Promise.all([t.write('a', streamOf('same')), t.write('a', streamOf('same'))]);
          });

          await assertManifestMatchesFiles(o);
          await assertReads(o, { a: 'same' });
        });

        it('concurrent writes of different content to one logical path end with the last one called', async () => {
          const o = newObject();
          const longer = 'A'.repeat(1_000_000);
          await o.update(async (t) => {
            await Promise.all([t.write('a', longer), t.write('a', 'BBB')]);
          });

          const inventory = await assertManifestMatchesFiles(o);
          assert.strictEqual(Object.keys(inventory.manifest).length, 1);
          assert.deepStrictEqual(Object.values(inventory.manifest), [['v1/content/a']]);
          await assertReads(o, { a: 'BBB' });
        });

        it('concurrent write, copy and remove give the same result as awaiting them in call order', async () => {
          const steps: ((t: OcflObjectTransaction) => Promise<void>)[] = [
            (t) => t.write('new', 'N'.repeat(100_000)),
            (t) => t.copy('new', 'copied'),
            (t) => t.remove('old'),
            (t) => t.copy('kept', 'old'),
            (t) => t.write('new-2', 'second'),
            (t) => t.copy('new-2', 'copied-2'),
          ];
          const seed = (o: OcflObject) =>
            o.update(async (t) => {
              await t.write('old', 'old');
              await t.write('kept', 'kept');
            });
          const sequential = newObject();
          await seed(sequential);
          await sequential.update(async (t) => {
            for (const step of steps) {
              await step(t);
            }
          });
          const concurrent = newObject();
          await seed(concurrent);
          await concurrent.update(async (t) => {
            await Promise.all(steps.map((step) => step(t)));
          });

          assert.deepStrictEqual((await readInventory(concurrent)).versions.v2!.state, (await readInventory(sequential)).versions.v2!.state);
          await assertManifestMatchesFiles(concurrent, 'v2');
        });

        it('a failed write rejects, leaves nothing behind, and a later write of that content stores it', async () => {
          const o = newObject();
          await o.update(async (t) => {
            const failed = path.join(o._workspace, 'v1/content/a');
            const [first, second] = await withFsFailure('rename', failed, () => Promise.allSettled([t.write('a', 'same'), t.write('b', 'same')]));
            assert.strictEqual(first.status, 'rejected');
            assert.strictEqual(second.status, 'fulfilled');
          });

          await assertManifestMatchesFiles(o);
          await assertReads(o, { b: 'same' });
        });
      });
    }

    it('a stream that fails leaves nothing behind', async () => {
      const o = newObject();
      await o.update(async (t) => {
        const broken = new ReadableStream({
          pull(controller) {
            controller.error(new Error('source failed'));
          },
        });
        await assert.rejects(t.write('broken', broken), /source failed/);
        await t.write('ok', 'ok');
      });

      await assertManifestMatchesFiles(o);
      await assertReads(o, { ok: 'ok' });
    });
  });

  describe('what write accepts', () => {
    let scenario = 0;

    const newObject = () => createObject(`accepts-${++scenario}`);

    const inputs: [string, () => WriteFileData][] = [
      ['a string', () => 'héllo'],
      ['a Buffer', () => Buffer.from('héllo')],
      ['a Uint16Array', () => new Uint16Array(encode('héllo!').buffer, 0, 3)],
      ['a DataView over part of a larger buffer', () => new DataView(encode('XXhélloXX').buffer, 2, 6)],
      ['an ArrayBuffer', () => encode('héllo').buffer],
      ['a Blob', () => new Blob(['hé', encode('llo')])],
      [
        'a Node Readable',
        () => {
          const source = path.join(tempdir, `accepts-source-${scenario}`);
          fs.writeFileSync(source, 'héllo');
          return fs.createReadStream(source);
        },
      ],
      ['a web ReadableStream', () => streamOf('héllo')],
      [
        'an async generator of strings and bytes',
        async function* () {
          yield 'hé';
          yield encode('l');
          yield Buffer.from('l');
          yield encode('o').buffer;
        },
      ],
    ];

    for (const [name, data] of inputs) {
      it(`stores the bytes of ${name} under their digest`, async () => {
        const o = newObject();
        await o.update(async (t) => {
          await t.write('a', data());
        });
        await assertValid(o, 'v1', { a: 'héllo' });
      });
    }

    const unsupported: [string, () => unknown, RegExp][] = [
      ['a number', () => 42, /Unsupported data type: \[object Number\]/],
      ['a plain object', () => ({ text: 'héllo' }), /Unsupported data type: \[object Object\]/],
      ['an iterable yielding something other than bytes or strings', () => Readable.from([{ text: 'héllo' }]), /Unsupported data type: \[object Object\]/],
    ];

    for (const [name, data, message] of unsupported) {
      it(`rejects ${name} and records nothing`, async () => {
        const o = newObject();
        await o.update(async (t) => {
          await assert.rejects(t.write('bad', data() as never), (e) => e instanceof TypeError && message.test(e.message));
          await t.write('ok', 'ok');
        });
        await assertManifestMatchesFiles(o);
        await assertReads(o, { ok: 'ok' });
      });
    }

    const failingPartway: [string, () => WriteFileData][] = [
      [
        'an async generator',
        async function* () {
          yield 'partial';
          throw new Error('source failed');
        },
      ],
      [
        'a web ReadableStream',
        () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(encode('partial'));
            },
            pull(controller) {
              controller.error(new Error('source failed'));
            },
          }),
      ],
      [
        'a Node Readable',
        () =>
          new Readable({
            read() {
              this.push('partial');
              this.destroy(new Error('source failed'));
            },
          }),
      ],
    ];

    for (const [name, data] of failingPartway) {
      it(`${name} that fails after its first chunk leaves nothing behind`, async () => {
        const o = newObject();
        await o.update(async (t) => {
          await assert.rejects(t.write('broken', data()), /source failed/);
          await t.write('ok', 'ok');
        });
        await assertValid(o, 'v1', { ok: 'ok' });
      });
    }

    it('stores the same content written as different types once', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'héllo');
        await t.write('b', new Blob(['héllo']));
        await t.write('c', encode('héllo').buffer);
      });
      const inventory = await assertManifestMatchesFiles(o);
      assert.deepStrictEqual(Object.keys(inventory.manifest), [sha512('héllo')]);
      await assertReads(o, { a: 'héllo', b: 'héllo', c: 'héllo' });
    });
  });

  describe('replacing a file within one version', () => {
    let scenario = 0;

    const newObject = () => createObject(`replace-${++scenario}`);

    type Write = (t: OcflObjectTransaction, logicalPath: string, content: string) => Promise<void>;
    const writes: [string, Write][] = [
      ['a string', (t, p, c) => t.write(p, c)],
      ['a buffer', (t, p, c) => t.write(p, encode(c))],
      ['a stream', (t, p, c) => t.write(p, streamOf(c))],
      [
        'import',
        async (t, p, c) => {
          const source = path.join(tempdir, `replace-source-${++scenario}`);
          await fs.promises.writeFile(source, c);
          await t.import(source, p);
        },
      ],
    ];

    const scenarios = [
      'a=AAA, a=BBB',
      'a=AAA, a=BBB, a=AAA',
      'a=AAA, a=BBB, c=AAA',
      'a=AAA, b=AAA, a=BBB',
      'a=AAA, a=AAA',
      'a=AAA, b=AAA, a=AAA',
      'a=AAA, b=BBB, a=BBB',
      'a=AAA, b=AAA, c=BBB, a=BBB',
      'a=AAA, c=AAA, b=BBB, a=BBB, c=CCC',
      'x/y/a=AAA, b=BBB, x/y/a=BBB',
      'x/a=AAA, b=AAA, c=BBB, x/a=BBB',
      'x/a=AAA, y/z/b=AAA, x/a=BBB',
    ];

    for (const [kind, write] of writes) {
      describe(`with ${kind}`, () => {
        for (const name of scenarios) {
          const steps = name.split(', ').map((step) => step.split('=') as [string, string]);
          const expected = Object.fromEntries(steps);
          it(`${name} commits and reads back`, async () => {
            const o = newObject();
            await o.update(async (t) => {
              for (const [logicalPath, content] of steps) {
                await write(t, logicalPath, content);
              }
            });
            await assertValid(o, 'v1', expected);
          });
        }
      });
    }

    it('leaves only the new content in the manifest', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.write('a', 'BBB');
      });
      const inventory = await readInventory(o);
      assert.deepStrictEqual(inventory.manifest, { [sha512('BBB')]: ['v1/content/a'] });
    });

    for (const [how, share] of [
      ['write', (t: OcflObjectTransaction) => t.write('b', 'AAA')],
      ['copy', (t: OcflObjectTransaction) => t.copy('a', 'b')],
    ] as const) {
      it(`stores shared content at the path of a logical path made with ${how}, with the manifest`, async () => {
        const o = newObject();
        await o.update(async (t) => {
          await t.write('a', 'AAA');
          await share(t);
          await t.write('a', 'BBB');
        });
        const inventory = await assertValid(o, 'v1', { a: 'BBB', b: 'AAA' });
        assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'], [sha512('BBB')]: ['v1/content/a'] });
      });
    }

    it('leaves earlier versions unchanged when the same replacements happen in v2', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.write('b', 'AAA');
      });
      const v1 = await readInventory(o);
      const v1File = await fs.promises.readFile(path.join(o.root, 'v1/content/a'));
      await o.update(async (t) => {
        await t.write('a', 'BBB');
        await t.write('c', 'BBB');
        await t.write('a', 'CCC');
        await t.write('b', 'DDD');
        await t.write('b', 'AAA');
      });
      const inventory = await assertValid(o, 'v2', { a: 'CCC', b: 'AAA', c: 'BBB' });
      assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
      assert.deepStrictEqual(await fs.promises.readFile(path.join(o.root, 'v1/content/a')), v1File);
    });

    it('leaves no content directory when replacements in v2 store nothing new', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.write('b', 'BBB');
      });
      await o.update(async (t) => {
        await t.write('a', 'CCC');
        await t.write('a', 'BBB');
      });
      await assertValid(o, 'v2', { a: 'BBB', b: 'BBB' });
      await assert.rejects(fs.promises.access(path.join(o.root, 'v2/content')), { code: 'ENOENT' });
    });

    it('keeps shared content where it was if the new content cannot be put in place', async () => {
      const o = newObject();
      const own = path.join(o._workspace, 'v1/content/a');
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.write('b', 'AAA');
        await withFsFailure(
          'rename',
          (source, target) => target === own && source.includes('.staged-'),
          () => assert.rejects(t.write('a', 'BBB'), /injected failure/),
        );
      });
      const inventory = await assertValid(o, 'v1', { a: 'AAA', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
    });

    it('leaves no directory behind from moving shared content when the new content cannot be put in place', async () => {
      const o = newObject();
      const own = path.join(o._workspace, 'v1/content/x/a');
      await o.update(async (t) => {
        await t.write('x/a', 'AAA');
        await t.write('y/z/b', 'AAA');
        await withFsFailure(
          'rename',
          (source, target) => target === own && source.includes('.staged-'),
          () => assert.rejects(t.write('x/a', 'BBB'), /injected failure/),
        );
      });
      await assertValid(o, 'v1', { 'x/a': 'AAA', 'y/z/b': 'AAA' });
    });
  });

  describe('renaming or removing a file within one version', () => {
    let scenario = 0;

    const newObject = () => createObject(`rename-remove-${++scenario}`);

    it('moves a file renamed in the version that added it, with its manifest entry', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.rename('a', 'b');
      });
      const inventory = await assertValid(o, 'v1', { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'] });
    });

    it('removes the file and manifest entry of content nothing else uses', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.write('keep', 'KKK');
        await t.remove('a');
      });
      const inventory = await assertValid(o, 'v1', { keep: 'KKK' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('KKK')]: ['v1/content/keep'] });
    });

    it('leaves no manifest entry or content directory when the only file is removed', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.remove('a');
      });
      const inventory = await assertValid(o, 'v1', {});
      assert.deepStrictEqual(inventory.manifest, {});
      await assert.rejects(fs.promises.access(path.join(o.root, 'v1/content')), { code: 'ENOENT' });
    });

    type Step = (t: OcflObjectTransaction) => Promise<void>;
    const scenarios: [string, Step[], Record<string, string>, string[]][] = [
      ['rename a directory', [(t) => t.write('d/x', 'XXX'), (t) => t.rename('d', 'e')], { 'e/x': 'XXX' }, ['v1/content/e/x']],
      ['rename to a target in a new directory', [(t) => t.write('a', 'AAA'), (t) => t.rename('a', 'x/y/b')], { 'x/y/b': 'AAA' }, ['v1/content/x/y/b']],
      [
        'rename a file that has a copy',
        [(t) => t.write('a', 'AAA'), (t) => t.copy('a', 'b'), (t) => t.rename('a', 'c')],
        { b: 'AAA', c: 'AAA' },
        ['v1/content/c'],
      ],
      [
        'rename a copy whose content is stored at another path',
        [(t) => t.write('a', 'AAA'), (t) => t.copy('a', 'b'), (t) => t.rename('b', 'c')],
        { a: 'AAA', c: 'AAA' },
        ['v1/content/a'],
      ],
      [
        'rename a directory holding two paths with the same content',
        [(t) => t.write('d/x', 'AAA'), (t) => t.write('d/y', 'AAA'), (t) => t.rename('d', 'e')],
        { 'e/x': 'AAA', 'e/y': 'AAA' },
        ['v1/content/e/x'],
      ],
      [
        'rename a file, then write new content to the old name',
        [(t) => t.write('a', 'AAA'), (t) => t.rename('a', 'b'), (t) => t.write('a', 'ZZZ')],
        { a: 'ZZZ', b: 'AAA' },
        ['v1/content/a', 'v1/content/b'],
      ],
      [
        'rename a file, then write the same content to the old name',
        [(t) => t.write('a', 'AAA'), (t) => t.rename('a', 'b'), (t) => t.write('a', 'AAA')],
        { a: 'AAA', b: 'AAA' },
        ['v1/content/b'],
      ],
      ['rename a file and back again', [(t) => t.write('a', 'AAA'), (t) => t.rename('a', 'b'), (t) => t.rename('b', 'a')], { a: 'AAA' }, ['v1/content/a']],
      [
        'remove the file storing content another path shares',
        [(t) => t.write('a', 'AAA'), (t) => t.write('b', 'AAA'), (t) => t.remove('a')],
        { b: 'AAA' },
        ['v1/content/b'],
      ],
      [
        'remove a path whose content is stored at another path',
        [(t) => t.write('a', 'AAA'), (t) => t.write('b', 'AAA'), (t) => t.remove('b')],
        { a: 'AAA' },
        ['v1/content/a'],
      ],
      ['remove a file that has a copy', [(t) => t.write('a', 'AAA'), (t) => t.copy('a', 'b'), (t) => t.remove('a')], { b: 'AAA' }, ['v1/content/b']],
      [
        'remove a file, then write identical content',
        [(t) => t.write('a', 'AAA'), (t) => t.remove('a'), (t) => t.write('a', 'AAA')],
        { a: 'AAA' },
        ['v1/content/a'],
      ],
      ['remove a directory', [(t) => t.write('d/x', 'XXX'), (t) => t.write('d/y/z', 'ZZZ'), (t) => t.remove('d')], {}, []],
      [
        'remove a directory whose content is also used outside it',
        [(t) => t.write('d/x', 'AAA'), (t) => t.write('d/y', 'AAA'), (t) => t.write('z', 'AAA'), (t) => t.remove('d')],
        { z: 'AAA' },
        ['v1/content/z'],
      ],
      [
        'remove a file, then rename another onto its name',
        [(t) => t.write('a', 'AAA'), (t) => t.write('b', 'BBB'), (t) => t.remove('b'), (t) => t.rename('a', 'b')],
        { b: 'AAA' },
        ['v1/content/b'],
      ],
    ];

    for (const [name, steps, expected, files] of scenarios) {
      it(`${name}: commits, stays valid and reads back`, async () => {
        const o = newObject();
        await o.update(async (t) => {
          for (const step of steps) {
            await step(t);
          }
        });
        const inventory = await assertValid(o, 'v1', expected);
        assert.deepStrictEqual(await contentFiles(o, 'v1'), files);
        assert.deepStrictEqual(Object.values(inventory.manifest).flat().sort(), files);
      });
    }

    async function committed(files: Record<string, string>) {
      const o = newObject();
      await o.update(async (t) => {
        for (const [logicalPath, content] of Object.entries(files)) {
          await t.write(logicalPath, content);
        }
      });
      return { o, inventory: await readInventory(o) };
    }

    it('renames a directory mixing committed and new files, leaving earlier versions unchanged', async () => {
      const { o, inventory: v1 } = await committed({ 'd/old': 'OLD' });
      await o.update(async (t) => {
        await t.write('d/new', 'NEW');
        await t.rename('d', 'e');
      });
      const inventory = await assertValid(o, 'v2', { 'e/old': 'OLD', 'e/new': 'NEW' });
      assert.deepStrictEqual(await contentFiles(o, 'v2'), ['v2/content/e/new']);
      assert.deepStrictEqual(inventory.manifest[sha512('OLD')], v1.manifest[sha512('OLD')]);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
    });

    it('removes a directory mixing committed and new files, leaving earlier versions unchanged', async () => {
      const { o, inventory: v1 } = await committed({ 'd/old': 'OLD', keep: 'KKK' });
      await o.update(async (t) => {
        await t.write('d/new', 'NEW');
        await t.remove('d');
      });
      const inventory = await assertValid(o, 'v2', { keep: 'KKK' });
      assert.deepStrictEqual(await contentFiles(o, 'v2'), []);
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
    });

    it('renaming a committed file changes only the logical path', async () => {
      const { o, inventory: v1 } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.rename('a', 'b');
      });
      const inventory = await assertValid(o, 'v2', { b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, v1.manifest);
      assert.deepStrictEqual(await contentFiles(o, 'v2'), []);
    });

    it('moves a file renamed in a later version without touching committed content', async () => {
      const { o, inventory: v1 } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.write('b', 'BBB');
        await t.rename('b', 'c');
        await t.copy('a', 'b');
      });
      const inventory = await assertValid(o, 'v2', { a: 'AAA', b: 'AAA', c: 'BBB' });
      assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
      assert.deepStrictEqual(inventory.manifest[sha512('BBB')], ['v2/content/c']);
    });

    it('reinstating a file over content this version wrote removes that content', async () => {
      const { o, inventory: v1 } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.write('a', 'NEW');
        await t.write('b', 'BBB');
        await t.reinstate('a', 1);
      });
      const inventory = await assertValid(o, 'v2', { a: 'AAA', b: 'BBB' });
      assert.deepStrictEqual(await contentFiles(o, 'v2'), ['v2/content/b']);
      assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
    });

    it('reinstating a file moves content this version wrote to its remaining copy', async () => {
      const { o } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.write('a', 'NEW');
        await t.copy('a', 'c');
        await t.reinstate('a', 1);
      });
      const inventory = await assertValid(o, 'v2', { a: 'AAA', c: 'NEW' });
      assert.deepStrictEqual(inventory.manifest[sha512('NEW')], ['v2/content/c']);
    });

    it('reinstating a file over a directory this version wrote throws FILE_EXISTS and keeps its content', async () => {
      const { o } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.remove('a');
        await t.write('a/x', 'XXX');
        await t.write('b', 'BBB');
        await assert.rejects(t.reinstate('a', 1), ocflError('FILE_EXISTS'));
      });
      await assertValid(o, 'v2', { 'a/x': 'XXX', b: 'BBB' });
      assert.deepStrictEqual(await contentFiles(o, 'v2'), ['v2/content/a/x', 'v2/content/b']);
    });

    it('writes a file again after reinstating over content this version wrote', async () => {
      const { o } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.write('a', 'NEW');
        await t.reinstate('a', 1);
        await t.remove('a');
        await t.write('a', 'THREE');
      });
      const inventory = await assertValid(o, 'v2', { a: 'THREE' });
      assert.deepStrictEqual(inventory.manifest[sha512('THREE')], ['v2/content/a']);
    });

    it('writing and removing a file in a later version creates no new version', async () => {
      const { o } = await committed({ a: 'AAA' });
      await o.update(async (t) => {
        await t.write('b', 'BBB');
        await t.remove('b');
      });
      assert.strictEqual((await readInventory(o)).head, 'v1');
      await assert.rejects(fs.promises.access(path.join(o.root, 'v2')), { code: 'ENOENT' });
    });

    it('puts files back and keeps the source when renaming a directory fails partway', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('d/x', 'XXX');
        await t.write('d/y', 'YYY');
        await withFsFailure(
          'rename',
          (source, target) => source.endsWith('/content/d/y') && target.endsWith('/content/e/y'),
          () => assert.rejects(t.rename('d', 'e'), /injected failure/),
        );
      });
      await assertValid(o, 'v1', { 'd/x': 'XXX', 'd/y': 'YYY' });
    });

    it('refuses to commit after a removal fails, leaving no partial object', async () => {
      const o = newObject();
      await assert.rejects(
        o.update(async (t) => {
          await t.write('d/x', 'XXX');
          await t.write('d/y', 'YYY');
          await withFsFailure(
            'rm',
            (target) => target.endsWith('/content/d/y'),
            () => assert.rejects(t.remove('d'), /injected failure/),
          );
        }),
        /injected failure/,
      );
      await assert.rejects(fs.promises.access(path.join(o.root, 'inventory.json')), { code: 'ENOENT' });
    });

    it('reports the original failure and refuses to commit when a move cannot be undone', async () => {
      const o = newObject();
      await assert.rejects(
        o.update(async (t) => {
          await t.write('d/x', 'XXX');
          await t.write('d/y', 'YYY');
          await withFsFailure(
            'rename',
            (source, target) => (source.endsWith('/content/d/y') && target.endsWith('/content/e/y')) || source.endsWith('/content/e/x'),
            () => assert.rejects(t.rename('d', 'e'), /injected failure/),
          );
        }),
        /injected failure/,
      );
      await assert.rejects(fs.promises.access(path.join(o.root, 'inventory.json')), { code: 'ENOENT' });
    });

    it('moves and removes new files in the workspace before they reach the object', async () => {
      const o = createObject(`rename-remove-${++scenario}`);
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await t.rename('a', 'x/b');
        await t.write('c', 'CCC');
        await t.remove('c');
      });
      const inventory = await assertValid(o, 'v1', { 'x/b': 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/x/b'] });
    });

    it('rejects a missing rename source without moving anything', async () => {
      const o = newObject();
      await o.update(async (t) => {
        await t.write('a', 'AAA');
        await assert.rejects(t.rename('missing', 'b'), { code: 'FILE_NOT_FOUND' });
      });
      await assertValid(o, 'v1', { a: 'AAA' });
    });
  });

  after(async () => {
    // delete temp dir
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
});

describe('digestAlgorithm and contentDirectory', () => {
  let tempdir: string;
  let written: string;

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-properties-'));
    written = path.join(tempdir, 'written');
    await testObject({ id: 'written', root: written, digestAlgorithm: 'sha256', contentDirectory: 'data' }).update(async (t) => t.write('a.txt', 'a'));
  });

  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('reports the values of an existing object loaded with default config', async () => {
    const o = testObject({ root: written });
    await o.load();
    assert.strictEqual(o.digestAlgorithm, 'sha256');
    assert.strictEqual(o.contentDirectory, 'data');
  });

  it('reports the configured values until the inventory has been read', async () => {
    const o = testObject({ root: written, digestAlgorithm: 'sha512', contentDirectory: 'stuff' });
    assert.strictEqual(o.digestAlgorithm, 'sha512');
    assert.strictEqual(o.contentDirectory, 'stuff');
    await o.getInventory();
    assert.strictEqual(o.digestAlgorithm, 'sha256');
    assert.strictEqual(o.contentDirectory, 'data');
  });

  it('reports the defaults before the inventory has been read when nothing is configured', () => {
    const o = testObject({ root: written });
    assert.strictEqual(o.digestAlgorithm, 'sha512');
    assert.strictEqual(o.contentDirectory, 'content');
  });

  it('reports the configured values for an object that does not exist yet, even after a load', async () => {
    const o = testObject({ root: path.join(tempdir, 'not-yet'), digestAlgorithm: 'sha256', contentDirectory: 'data' });
    await o.getInventory();
    assert.strictEqual(o.digestAlgorithm, 'sha256');
    assert.strictEqual(o.contentDirectory, 'data');
  });

  it('reports the defaults for an object that does not exist yet with nothing configured', () => {
    const o = testObject({ root: path.join(tempdir, 'not-yet') });
    assert.strictEqual(o.digestAlgorithm, 'sha512');
    assert.strictEqual(o.contentDirectory, 'content');
  });

  it('reports the spec default for an inventory with no contentDirectory, whatever is configured', async () => {
    const o = testObject({ root: fixture, digestAlgorithm: 'sha256', contentDirectory: 'data' });
    await o.load();
    assert.strictEqual(o.digestAlgorithm, 'sha512');
    assert.strictEqual(o.contentDirectory, 'content');
  });

  it('creates a new object with its configured values', async () => {
    const root = path.join(tempdir, 'configured');
    const content = 'configured content';
    const o = testObject({ id: 'configured', root, digestAlgorithm: 'sha256', contentDirectory: 'data' });
    await o.update(async (t) => t.write('a.txt', content));

    const inv = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')) as Inventory;
    const digest = createHash('sha256').update(content).digest('hex');
    assert.strictEqual(inv.digestAlgorithm, 'sha256');
    assert.strictEqual(inv.contentDirectory, 'data');
    assert.deepStrictEqual(inv.manifest, { [digest]: ['v1/data/a.txt'] });
    assert.strictEqual(await fs.promises.readFile(path.join(root, 'v1/data/a.txt'), 'utf8'), content);
    assert.strictEqual(o.digestAlgorithm, 'sha256');
    assert.strictEqual(o.contentDirectory, 'data');
  });

  it('creates a new object with the defaults when nothing is configured', async () => {
    const root = path.join(tempdir, 'defaulted');
    await testObject({ id: 'defaulted', root }).update(async (t) => t.write('a.txt', 'a'));

    const inv = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')) as Inventory;
    assert.strictEqual(inv.digestAlgorithm, 'sha512');
    assert.strictEqual(inv.contentDirectory, 'content');
    assert.ok(fs.existsSync(path.join(root, 'v1/content/a.txt')));
  });

  it('keeps the object values when an update is configured differently', async () => {
    const root = path.join(tempdir, 'differs');
    await testObject({ id: 'differs', root, digestAlgorithm: 'sha256', contentDirectory: 'data' }).update(async (t) => t.write('a.txt', 'a'));

    const o = testObject({ root, digestAlgorithm: 'sha512', contentDirectory: 'stuff' });
    await o.update(async (t) => t.write('b.txt', 'b'));

    const inv = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')) as Inventory;
    assert.strictEqual(inv.digestAlgorithm, 'sha256');
    assert.strictEqual(inv.contentDirectory, 'data');
    assert.ok(fs.existsSync(path.join(root, 'v2/data/b.txt')));
    assert.strictEqual(o.digestAlgorithm, 'sha256');
    assert.strictEqual(o.contentDirectory, 'data');
  });

  for (const property of ['digestAlgorithm', 'contentDirectory'] as const) {
    it(`has no setter for ${property}`, () => {
      const o: Record<typeof property, string> = testObject({ root: written });
      assert.throws(() => {
        o[property] = 'sha256';
      }, TypeError);
    });
  }
});

describe('file lookup errors', () => {
  let tempdir: string;
  const missingObject = () => testObject({ id: 'missing', root: path.join(tempdir, 'missing') });

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-lookup-'));
  });

  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('keeps serving getFile from the loaded inventory while reloading', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    const reload = o.load();
    assert.ok(o.getFile('foo/bar.xml'));
    await reload;
  });

  it('throws ObjectNotLoadedError from getFile before load', () => {
    const o = testObject({ root: fixture });
    assert.throws(() => o.getFile('foo/bar.xml'), ObjectNotLoadedError);
    assert.throws(() => o.getFile('foo/bar.xml'), { name: 'ObjectNotLoadedError', message: /spec-ex-full.*load\(\)/ });
  });

  it('throws ObjectNotFoundError from getFile after loading an object that does not exist', async () => {
    const o = missingObject();
    await o.load();
    assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
    assert.throws(() => o.getFile('a.txt'), { name: 'ObjectNotFoundError', message: 'OCFL Object "missing" does not exist' });
  });

  it('throws ObjectNotFoundError from getFile by digest and content path after loading an object that does not exist', async () => {
    const o = missingObject();
    await o.load();
    assert.throws(() => o.getFile({ digest: 'abc' }), ObjectNotFoundError);
    assert.throws(() => o.getFile({ contentPath: 'v1/content/a.txt' }), ObjectNotFoundError);
  });

  it('returns a lazy file without loading, which throws ObjectNotFoundError on read if the object does not exist', async () => {
    const o = missingObject();
    const file = o.getFile('a.txt', undefined, true);
    assert.strictEqual(file?.logicalPath, 'a.txt');
    await assert.rejects(file.text(), ObjectNotFoundError);
    await assert.rejects(o.count(), ObjectNotFoundError);
    await assert.rejects(o.files(), ObjectNotFoundError);
  });

  it('reads a lazy file from an existing object without loading', async () => {
    const o = testObject({ root: fixture });
    const expected = await fs.promises.readFile(path.join(fixture, 'v2/content/foo/bar.xml'), 'utf8');
    assert.strictEqual(await o.getFile('foo/bar.xml', undefined, true)?.text(), expected);
  });

  it('finds a file in an existing object by logical path, digest and content path', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    const byPath = o.getFile('foo/bar.xml');
    assert.strictEqual(byPath?.contentPath, 'v2/content/foo/bar.xml');
    assert.strictEqual(o.getFile({ digest: byPath.digest! })?.contentPath, 'v2/content/foo/bar.xml');
    assert.strictEqual(o.getFile({ contentPath: 'v2/content/foo/bar.xml' })?.logicalPath, 'foo/bar.xml');
  });

  it('returns undefined for a file that is not in an existing object', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    assert.strictEqual(o.getFile('nope.txt'), undefined);
    assert.strictEqual(o.getFile({ digest: 'abc' }), undefined);
    assert.strictEqual(o.getFile({ contentPath: 'v1/content/nope.txt' }), undefined);
  });

  it('rejects load with the stat error when filesMetadata meets a dangling symlink', async () => {
    const root = path.join(tempdir, 'dangling-symlink');
    await testObject({ id: 'dangling-symlink', root }).update(async (t) => t.write('a.txt', 'a'));
    await fs.promises.symlink(path.join(tempdir, 'nowhere'), path.join(root, 'dangling'));
    await assert.rejects(testObject({ root }).load({ filesMetadata: true }), { code: 'ENOENT', syscall: 'stat' });
  });

  it('rejects load with the opendir error when filesMetadata meets an unreadable directory', { skip: process.getuid?.() === 0 }, async () => {
    const root = path.join(tempdir, 'unreadable-directory');
    await testObject({ id: 'unreadable-directory', root }).update(async (t) => t.write('a.txt', 'a'));
    const unreadable = path.join(root, 'unreadable');
    await fs.promises.mkdir(unreadable, { mode: 0o000 });
    try {
      await assert.rejects(testObject({ root }).load({ filesMetadata: true }), { code: 'EACCES', syscall: 'opendir' });
    } finally {
      await fs.promises.chmod(unreadable, 0o700);
    }
  });
});

describe('refresh', () => {
  let tempdir: string;
  let objectCount = 0;

  async function committedObject() {
    const root = path.join(tempdir, `refresh-${++objectCount}`);
    await testObject({ id: `refresh-${objectCount}`, root }).update(async (t) => t.write('a.txt', 'v1'));
    return root;
  }

  async function loadedObject() {
    const root = await committedObject();
    const o = testObject({ root });
    await o.load();
    return { root, o };
  }

  /** Rewrite the root inventory and its sidecar so that the two match */
  async function rewriteInventory(root: string, edit: (inv: Inventory) => void) {
    const inv: Inventory = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8'));
    edit(inv);
    const data = JSON.stringify(inv);
    await fs.promises.writeFile(path.join(root, 'inventory.json'), data);
    await fs.promises.writeFile(
      path.join(root, `inventory.json.${inv.digestAlgorithm}`),
      `${createHash(inv.digestAlgorithm).update(data).digest('hex')} inventory.json\n`,
    );
  }

  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-refresh-'));
  });

  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('behaves like load on a never-loaded object', async () => {
    const root = await committedObject();
    const o = testObject({ root });
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v1');
  });

  it('rejects with E060 on a mismatched never-loaded object', async () => {
    const root = await committedObject();
    await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), 'abc inventory.json\n');
    await assert.rejects(testObject({ root }).refresh(), { code: 'E060' });
  });

  it('reports a never-loaded object that does not exist as missing', async () => {
    const o = testObject({ id: 'missing', root: path.join(tempdir, 'missing') });
    await o.refresh();
    assert.strictEqual(o.inventory, undefined);
    assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
  });

  it('picks up a version committed by another instance', async () => {
    const { root, o } = await loadedObject();
    await testObject({ root }).update(async (t) => t.write('b.txt', 'v2'));
    assert.strictEqual(o.inventory?.head, 'v1');
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v2');
    assert.strictEqual(await o.getFile('b.txt')?.text(), 'v2');
    assert.strictEqual((await o.getInventory('v1'))?.head, 'v1');
  });

  it('does not read inventory.json while the sidecar is unchanged', async () => {
    const { root, o } = await loadedObject();
    await fs.promises.rm(path.join(root, 'inventory.json'));
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v1');
  });

  it('does not read inventory.json after committing through the same instance', async () => {
    const root = await committedObject();
    const o = testObject({ root });
    await o.update(async (t) => t.write('b.txt', 'v2'));
    await fs.promises.rm(path.join(root, 'inventory.json'));
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v2');
  });

  it('keeps the last good inventory during a commit, then picks up the new one', async () => {
    const { root, o } = await loadedObject();
    const sidecar = path.join(root, 'inventory.json.sha512');
    await testObject({ root }).update(async (t) => t.write('b.txt', 'v2'));
    const committed = await fs.promises.readFile(sidecar);
    await fs.promises.writeFile(sidecar, 'abc inventory.json\n');
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v1');
    assert.ok(o.getFile('a.txt'));
    await fs.promises.writeFile(sidecar, committed);
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v2');
  });

  it('keeps the last good inventory when inventory.json is partly written', async () => {
    const { root, o } = await loadedObject();
    await fs.promises.writeFile(path.join(root, 'inventory.json'), '{"id":');
    await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), 'abc inventory.json\n');
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v1');
  });

  it('keeps the last good inventory when the sidecar is missing but inventory.json is not', async () => {
    const { root, o } = await loadedObject();
    await fs.promises.rm(path.join(root, 'inventory.json.sha512'));
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v1');
  });

  it('still rejects a new inventory that matches its sidecar but is invalid', async () => {
    const { root, o } = await loadedObject();
    await rewriteInventory(root, (inv) => {
      inv.head = '';
    });
    await assert.rejects(o.refresh(), { code: 'E040' });
    assert.strictEqual(o.inventory?.head, 'v1');
  });

  it('keeps cached past version inventories when a new version arrives', async () => {
    const root = await committedObject();
    const writer = testObject({ root });
    await writer.update(async (t) => t.write('b.txt', 'v2'));
    const o = testObject({ root });
    await o.load();
    const v1 = await o.getInventory('v1');
    await writer.update(async (t) => t.write('c.txt', 'v3'));
    await fs.promises.rm(path.join(root, 'v1/inventory.json'));
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v3');
    assert.strictEqual(await o.getInventory('v1'), v1);
  });

  it('keeps the cached inventory of the former head when a new version arrives', async () => {
    const { root, o } = await loadedObject();
    const v1 = await o.getInventory('v1');
    await testObject({ root }).update(async (t) => t.write('b.txt', 'v2'));
    await fs.promises.rm(path.join(root, 'v1/inventory.json'));
    await o.refresh();
    assert.strictEqual(o.inventory?.head, 'v2');
    assert.strictEqual(await o.getInventory('v1'), v1);
  });

  it('does not replace an inventory that became newer while refreshing', async () => {
    const { root, o } = await loadedObject();
    const writer = testObject({ root });
    await writer.update(async (t) => t.write('b.txt', 'v2'));
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readFile = o.readFile.bind(o) as (relPath: string, options?: unknown) => Promise<string>;
    let sidecarReads = 0;
    const spy = mock.method(o, 'readFile', async (relPath: string, options?: unknown) => {
      const data = await readFile(relPath, options);
      // The first read detects the change, the second verifies the v2 inventory
      if (relPath === 'inventory.json.sha512' && ++sidecarReads === 2) {
        reached.resolve();
        await release.promise;
      }
      return data;
    });
    const refreshing = o.refresh();
    await reached.promise;
    spy.mock.restore();
    await writer.update(async (t) => t.write('c.txt', 'v3'));
    await o.load();
    release.resolve();
    await refreshing;
    assert.strictEqual(o.inventory?.head, 'v3');
  });

  it('clears the cache when the object no longer exists', async () => {
    const { root, o } = await loadedObject();
    await o.getInventory('v1');
    await fs.promises.rm(root, { recursive: true });
    await o.refresh();
    assert.strictEqual(o.inventory, undefined);
    assert.strictEqual(await o.getInventory('v1'), undefined);
    assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
  });

  it('picks up a new version whose digest algorithm changed', async () => {
    const { root, o } = await loadedObject();
    await rewriteInventory(root, (inv) => {
      inv.digestAlgorithm = 'sha256';
    });
    await fs.promises.rm(path.join(root, 'inventory.json.sha512'));
    await o.refresh();
    assert.strictEqual(o.inventory?.digestAlgorithm, 'sha256');
  });
});

describe("'latest' version name", () => {
  const logicalPath = 'foo/bar.xml';
  const headContentPath = 'v2/content/foo/bar.xml';

  it('finds the head file like the explicit head version', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    const explicit = o.getFile(logicalPath, 'v3');
    assert.strictEqual(explicit?.version, 'v3');
    assert.strictEqual(explicit.contentPath, headContentPath);
    const digest = explicit.digest!;
    const found = [
      o.getFile(logicalPath, 'latest'),
      o.getFile({ logicalPath, version: 'latest' }),
      o.getFile({ digest, version: 'latest' }),
      o.getFile({ contentPath: headContentPath, version: 'latest' }),
    ];
    for (const file of found) {
      assert.deepStrictEqual(file, explicit);
    }
  });

  it('treats an empty version name as a version that does not exist', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    const digest = o.getFile(logicalPath)!.digest!;
    assert.strictEqual(o.getFile(logicalPath, ''), undefined);
    assert.strictEqual(o.getFile({ logicalPath, version: '' }), undefined);
    assert.strictEqual(o.getFile({ digest, version: '' }), undefined);
    assert.strictEqual(o.getFile({ contentPath: headContentPath, version: '' }), undefined);
    await assert.rejects(testObject({ root: fixture }).getFile(logicalPath, '', true)!.text(), { code: 'FILE_NOT_FOUND' });
  });

  it('leaves explicit older versions unchanged', async () => {
    const o = testObject({ root: fixture });
    await o.load();
    const file = o.getFile(logicalPath, 'v1');
    assert.strictEqual(file?.version, 'v1');
    assert.strictEqual(file.contentPath, 'v1/content/foo/bar.xml');
    assert.deepStrictEqual(o.getFile({ logicalPath, version: 'v1' }), file);
    assert.deepStrictEqual(o.getFile({ digest: file.digest!, version: 'v1' }), file);
    assert.deepStrictEqual(o.getFile({ contentPath: 'v1/content/foo/bar.xml', version: 'v1' }), file);
  });
});

describe('spec violations', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-object-errors-'));
  });

  it('reports E007 when the version declaration has the wrong contents', async () => {
    const root = path.join(tempdir, 'bad-namaste');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, '0=ocfl_object_1.1'), 'wrong\n');
    const o = testObject({ id: 'bad-namaste', root });
    await assert.rejects(
      o.update(async (t) => t.write('a.txt', 'a')),
      { code: 'E007', path: root },
    );
  });

  it('reports E060 when the inventory sidecar digest does not match', async () => {
    const root = path.join(tempdir, 'bad-sidecar');
    await testObject({ id: 'bad-sidecar', root }).update(async (t) => t.write('a.txt', 'a'));
    await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), 'abc inventory.json\n');
    await assert.rejects(testObject({ root }).load(), { code: 'E060' });
  });

  it('reports E082 when an object root is nested in another object', async () => {
    const parent = path.join(tempdir, 'parent');
    await testObject({ id: 'parent', root: parent }).update(async (t) => t.write('a.txt', 'a'));
    const child = testObject({ id: 'child', root: path.join(parent, 'child') });
    await assert.rejects(
      child.update(async (t) => t.write('b.txt', 'b')),
      { code: 'E082' },
    );
  });

  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });
});
