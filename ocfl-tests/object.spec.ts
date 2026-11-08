import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
import { type Inventory, ObjectNotFoundError, ObjectNotLoadedError, type OcflObject, type OcflObjectConfig, type OcflVersion } from '@ocfl/ocfl';
import type { Ocfl } from './index.ts';

export default (ocfl: Ocfl) => {
  let objcount = 0;

  async function validateFile(object: OcflObject, srcPath: string, logicalPath: string) {
    const content = await fs.promises.readFile(srcPath);
    const digest = createHash('sha512').update(content).digest('hex');
    const inv = (await object.getInventory())!;
    assert.strictEqual(inv.manifest[digest]?.length, 1);
    assert.ok(inv.state[digest]!.includes(logicalPath));
    assert.strictEqual(content.toString(), await object.getFile({ digest })!.asString());
    assert.strictEqual(content.toString(), await object.getFile({ logicalPath })!.asString());
  }

  before(() => {
    //object = ocfl.object({ root: '/data/objects/object-1' });
  });

  // describe("object encapsulation", function () {
  //   it("cannot access protected properties", function () {
  //     assert.equal(object._getInventory, null);
  //   });
  // });

  describe('constructor', () => {
    it('can create new object', () => {
      let object: OcflObject;
      object = ocfl.object({ root: '/data/objects/object-1' });
      assert.equal(object.root, '/data/objects/object-1');
      object = ocfl.object({ root: '/data/objects/object-1', digestAlgorithm: 'sha256', id: 'object-1' });
      assert.equal(object.root, '/data/objects/object-1');
      assert.equal(object.id, 'object-1');
      assert.throws(() => {
        object = ocfl.object({ root: '/data/objects/object-1', workspace: '/data/objects/object-1' });
      });
    });
  });

  describe('access existing object', () => {
    let invRaw: Inventory, invRawFiles: string[];
    let object = ocfl.object({ root: '/tmp/dummy' });

    before(async () => {
      const config = { root: path.join(import.meta.dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full') };
      object = ocfl.object(config);
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
      const content = await object.getFile('foo/bar.xml')!.asString();
      assert.equal(content, actualContent);
    });
    it('can read a file as buffer', async () => {
      const actualContent = await fs.promises.readFile(path.join(object.root, 'v1/content/image.tiff'));
      const content = (await object.getFile('image.tiff')!.asBuffer()) as Buffer;
      assert.equal(content.compare(actualContent), 0);
    });
    it('can read a file as stream', async () => {
      const actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'));
      //fileContent['empty2.txt'] = await fs.promises.readFile(path.join(config.root, 'v1/content/empty.txt'));
      // for (let f of await object.files()) {
      //   let content = await object.getAsBuffer(f);
      //   assert.equal(content.compare(fileContent[f.logicalPath]), 0);
      // }
      const stream = await object.getFile('foo/bar.xml')!.asStream();
      const buffers = [];
      for await (const data of stream) {
        buffers.push(data);
      }
      const content = Buffer.concat(buffers);
      assert.equal(content.compare(actualContent), 0);
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

    function createObject(id: string, useWorkspace: boolean, ocflVersion?: OcflVersion) {
      const config: OcflObjectConfig = { id, root: path.join(tempdir, id), ocflVersion, fixityAlgorithms: ['md5', 'crc32'] };
      if (useWorkspace) {
        config.workspace = `${config.root}-tmp`;
      }
      return ocfl.object(config);
    }

    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-object-'));
      objectx = createObject('object-x', true);
    });

    it('can detect error of unfinished operations', async () => {
      let ow = createObject('object-we1', true);
      await ow.update(async (t) => t.write('a.txt', 'a'));
      // @ts-expect-error deliberately not async
      const p1 = ow.update((t) => {
        t.write('test.txt', 'test');
      });
      await assert.rejects(p1);
      ow = createObject('object-we2', true);
      const p2 = ow.update(async (t) => {
        // wrong, must use await or return as a promise
        t.write('test.txt', 'test');
      });
      await assert.rejects(p2);
    });

    it('can clean up after error', async () => {
      const o = createObject('object-we3', true);
      await assert.rejects(fs.promises.access(o.workspace!));
      try {
        await o.update(async (t) => {
          await t.write('test.txt', 'test');
          await fs.promises.access(o.workspace!);
          throw new Error('test');
        });
      } catch {}
      await assert.rejects(fs.promises.access(o.workspace!));
      await assert.rejects(fs.promises.access(o.root));
    });

    it('does not allow nested objects', async () => {
      const o = createObject('object-we4', true);
      await o.update(async (t) => {
        await t.write('test.txt', 'test');
      });
      assert.strictEqual(await fs.promises.readFile(path.join(o.root, 'v1/content/test.txt'), 'utf8'), 'test');
      const o1 = createObject('object-we4/object-we5', true);
      const o2 = createObject('object-we4/test/object-we5', true);
      await assert.rejects(o1.update(async (t) => t.write('test.txt', 'test')));
      await assert.rejects(o2.update(async (t) => t.write('test.txt', 'test')));
    });

    for (const useWorkspace of [true, false]) {
      for (const ocflVersion of ocfl.OCFL_VERSIONS) {
        it(`can create correct namaste and inventory, with${useWorkspace ? '' : 'out'} workspace, with version ${ocflVersion}`, async () => {
          objcount++;
          const o = createObject(`object-${objcount}`, useWorkspace, ocflVersion);
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
        await t.import(f2, '');
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
        await t.reinstate('test.txt', 'v3');
        // directory
        await t.reinstate('bar', 'v3');
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
      await objectx.update(async (t) => {
        // file
        await t.import(path.join(datadir, 'test_input.txt'));
        // directory
        await t.import(path.join(datadir, 'sample_dir'));
      }, 'REPLACE');
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
      const o = createObject('object-version-1', true);
      let c: string;
      await o.update(async (t) => {
        await t.write('test', 'test');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v1/content/test'), 'utf8');
      assert.strictEqual(c, 'test');
      assert.strictEqual(await o.getFile('test')!.asString(), 'test');
      await o.update(async (t) => {
        await t.write('test', 'testv2');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v2/content/test'), 'utf8');
      assert.strictEqual(c, 'testv2');
      assert.strictEqual(await o.getFile('test')!.asString(), 'testv2');
      await o.update(async (t) => {
        await t.write('test', 'test');
      });
      //console.log(o._inventory.latest.toString());
      //console.log(o._inventory.v3.toString());
      await assert.rejects(fs.promises.readFile(path.join(o.root, 'v3/content/test'), 'utf8'));
      assert.strictEqual(await o.getFile('test')!.asString(), 'test');
      await o.update(async (t) => {
        await t.write('test', 'testv4');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v4/content/test'), 'utf8');
      assert.strictEqual(c, 'testv4');
      assert.strictEqual(await o.getFile('test')!.asString(), 'testv4');
    });

    it('can add a directory without using transaction directly', async () => {
      const f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
      const o = createObject('object-import-1', true);
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
      const o = createObject('object-import-2', true);
      await o.import([f1, f2]);
      const inv = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inv.head, 'v1');
      await validateFile(o, path.join(f1, 'foo/bar.xml'), 'foo/bar.xml');
      await validateFile(o, path.join(f1, 'empty2.txt'), 'empty2.txt');
      await validateFile(o, path.join(f1, 'image.tiff'), 'image.tiff');
      await validateFile(o, path.join(f2, 'a file.wxy'), 'a file.wxy');
      await validateFile(o, path.join(f2, 'another file.xyz'), 'another file.xyz');
    });

    //@todo: check delete, rename, reinstate non existant logical path

    it('can add and list files with fixity', async () => {
      const content = 'test test test';
      await objectx.update(async (t) => {
        await t.write('test.txt', content);
      });
      for (const f of await objectx.files()) {
        assert(f.fixity!.md5);
        assert(f.fixity!.crc32);
        const fc = await f.text();
        assert.strictEqual(f.fixity!.md5, createHash('md5').update(fc).digest('hex'));
      }
      const file = await objectx.getFile('test.txt');
      assert.strictEqual(file!.fixity!.md5, createHash('md5').update(content).digest('hex'));
    });

    after(async () => {
      // delete temp dir
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });

  describe('file lookup errors', () => {
    const fixture = path.join(import.meta.dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full');
    let tempdir: string;
    const missingObject = () => ocfl.object({ id: 'missing', root: path.join(tempdir, 'missing') });

    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-lookup-'));
    });

    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });

    it('keeps serving getFile from the loaded inventory while reloading', async () => {
      const o = ocfl.object({ root: fixture });
      await o.load();
      const reload = o.load();
      assert.ok(o.getFile('foo/bar.xml'));
      await reload;
    });

    it('throws ObjectNotLoadedError from getFile before load', () => {
      const o = ocfl.object({ root: fixture });
      assert.throws(() => o.getFile('foo/bar.xml'), ObjectNotLoadedError);
      assert.throws(() => o.getFile('foo/bar.xml'), { name: 'ObjectNotLoadedError', message: /spec-ex-full.*load\(\)/ });
    });

    it('throws ObjectNotFoundError from getFile after loading an object that does not exist', async () => {
      const o = missingObject();
      await o.load();
      assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
      assert.throws(() => o.getFile('a.txt'), { name: 'ObjectNotFoundError', message: 'OCFL Object "missing" does not exist' });
    });

    it('throws ObjectNotFoundError from fileBy* for an object that does not exist', async () => {
      const o = missingObject();
      await assert.rejects(o.fileByLogicalPath('a.txt'), ObjectNotFoundError);
      await assert.rejects(o.fileByDigest('abc'), ObjectNotFoundError);
      await assert.rejects(o.fileByContentPath('v1/content/a.txt'), ObjectNotFoundError);
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
      const o = ocfl.object({ root: fixture });
      const expected = await fs.promises.readFile(path.join(fixture, 'v2/content/foo/bar.xml'), 'utf8');
      assert.strictEqual(await o.getFile('foo/bar.xml', undefined, true)?.text(), expected);
    });

    it('finds a file in an existing object by logical path, digest and content path', async () => {
      const o = ocfl.object({ root: fixture });
      const byPath = await o.fileByLogicalPath('foo/bar.xml');
      assert.strictEqual(byPath?.contentPath, 'v2/content/foo/bar.xml');
      assert.strictEqual((await o.fileByDigest(byPath.digest!))?.contentPath, 'v2/content/foo/bar.xml');
      assert.strictEqual((await o.fileByContentPath('v2/content/foo/bar.xml'))?.logicalPath, 'foo/bar.xml');
    });

    it('returns undefined for a file that is not in an existing object', async () => {
      const o = ocfl.object({ root: fixture });
      await o.load();
      assert.strictEqual(o.getFile('nope.txt'), undefined);
      assert.strictEqual(o.getFile({ digest: 'abc' }), undefined);
      assert.strictEqual(o.getFile({ contentPath: 'v1/content/nope.txt' }), undefined);
      assert.strictEqual(await o.fileByLogicalPath('nope.txt'), undefined);
      assert.strictEqual(await o.fileByDigest('abc'), undefined);
      assert.strictEqual(await o.fileByContentPath('v1/content/nope.txt'), undefined);
    });
  });

  describe('refresh', () => {
    let tempdir: string;
    let objectCount = 0;

    async function committedObject() {
      const root = path.join(tempdir, `refresh-${++objectCount}`);
      await ocfl.object({ id: `refresh-${objectCount}`, root }).update(async (t) => t.write('a.txt', 'v1'));
      return root;
    }

    async function loadedObject() {
      const root = await committedObject();
      const o = ocfl.object({ root });
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
      const o = ocfl.object({ root });
      await o.refresh();
      assert.strictEqual(o.inventory?.head, 'v1');
    });

    it('rejects with E060 on a mismatched never-loaded object', async () => {
      const root = await committedObject();
      await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), 'abc inventory.json\n');
      await assert.rejects(ocfl.object({ root }).refresh(), { code: 'E060' });
    });

    it('reports a never-loaded object that does not exist as missing', async () => {
      const o = ocfl.object({ id: 'missing', root: path.join(tempdir, 'missing') });
      await o.refresh();
      assert.strictEqual(o.inventory, undefined);
      assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
    });

    it('picks up a version committed by another instance', async () => {
      const { root, o } = await loadedObject();
      await ocfl.object({ root }).update(async (t) => t.write('b.txt', 'v2'));
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
      const o = ocfl.object({ root });
      await o.update(async (t) => t.write('b.txt', 'v2'));
      await fs.promises.rm(path.join(root, 'inventory.json'));
      await o.refresh();
      assert.strictEqual(o.inventory?.head, 'v2');
    });

    it('keeps the last good inventory during a commit, then picks up the new one', async () => {
      const { root, o } = await loadedObject();
      const sidecar = path.join(root, 'inventory.json.sha512');
      await ocfl.object({ root }).update(async (t) => t.write('b.txt', 'v2'));
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
      const writer = ocfl.object({ root });
      await writer.update(async (t) => t.write('b.txt', 'v2'));
      const o = ocfl.object({ root });
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
      await ocfl.object({ root }).update(async (t) => t.write('b.txt', 'v2'));
      await fs.promises.rm(path.join(root, 'v1/inventory.json'));
      await o.refresh();
      assert.strictEqual(o.inventory?.head, 'v2');
      assert.strictEqual(await o.getInventory('v1'), v1);
    });

    it('does not replace an inventory that became newer while refreshing', async () => {
      const { root, o } = await loadedObject();
      const writer = ocfl.object({ root });
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

  describe('spec violations', () => {
    let tempdir: string;
    before(async () => {
      tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-object-errors-'));
    });

    it('reports E007 when the version declaration has the wrong contents', async () => {
      const root = path.join(tempdir, 'bad-namaste');
      await fs.promises.mkdir(root);
      await fs.promises.writeFile(path.join(root, '0=ocfl_object_1.1'), 'wrong\n');
      const o = ocfl.object({ id: 'bad-namaste', root });
      await assert.rejects(
        o.update(async (t) => t.write('a.txt', 'a')),
        { code: 'E007', path: root },
      );
    });

    it('reports E060 when the inventory sidecar digest does not match', async () => {
      const root = path.join(tempdir, 'bad-sidecar');
      await ocfl.object({ id: 'bad-sidecar', root }).update(async (t) => t.write('a.txt', 'a'));
      await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), 'abc inventory.json\n');
      await assert.rejects(ocfl.object({ root }).load(), { code: 'E060' });
    });

    it('reports E082 when an object root is nested in another object', async () => {
      const parent = path.join(tempdir, 'parent');
      await ocfl.object({ id: 'parent', root: parent }).update(async (t) => t.write('a.txt', 'a'));
      const child = ocfl.object({ id: 'child', root: path.join(parent, 'child') });
      await assert.rejects(
        child.update(async (t) => t.write('b.txt', 'b')),
        { code: 'E082' },
      );
    });

    after(async () => {
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
};

//ocfl.OcflExtension.register(require('ocfl-extensions'));
//import d from 'ocfl-extension-dummy';
