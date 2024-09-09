const assert = require("assert");
const path = require("path");
const fs = require("fs");
const hasha = require("hasha");
const { Readable } = require("node:stream");
const { Ocfl, OcflObject } = require("@ocfl/ocfl");
const { createHash } = require('crypto');

/** 
 * @param {Ocfl} ocfl
 */
module.exports = function (ocfl) {
  let object;
  let objcount = 0;

  /**
   * 
   * @param {OcflObject} object 
   * @param {string} srcPath 
   * @param {string} logicalPath 
   */
  async function validateFile(object, srcPath, logicalPath) {
    let content = await fs.promises.readFile(srcPath);
    let digest = hasha(content, { algorithm: 'sha512' });
    let inv = await object.getInventory();
    assert.strictEqual(inv.manifest[digest]?.length, 1);
    assert.ok(inv.state[digest].includes(logicalPath));
    assert.strictEqual(content.toString(), await object.getFile({ digest }).asString());
    assert.strictEqual(content.toString(), await object.getFile({ logicalPath }).asString());
  }

  before(function () {
    //object = ocfl.object({ root: '/data/objects/object-1' });
  });

  // describe("object encapsulation", function () {
  //   it("cannot access protected properties", function () {
  //     assert.equal(object._getInventory, null);
  //   });
  // });

  describe("constructor", function () {
    it("can create new object", function () {
      let object;
      object = ocfl.object({ root: '/data/objects/object-1' });
      assert.equal(object.root, '/data/objects/object-1');
      object = ocfl.object({ root: '/data/objects/object-1', digestAlgorithm: "sha256", id: "object-1" });
      assert.equal(object.root, '/data/objects/object-1');
      assert.equal(object.id, 'object-1');
      assert.throws(() => {
        object = ocfl.object({ root: '/data/objects/object-1', workspace: '/data/objects/object-1' });
      });
    });

  });

  describe("access existing object", function () {
    let invRaw, invRawFiles;
    let object = ocfl.object({ root: '/tmp/dummy' });

    before(async function () {
      let config = { root: path.join(__dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full') };
      object = ocfl.object(config);
      invRaw = JSON.parse(await fs.promises.readFile(path.join(config.root, 'inventory.json'), 'utf8'));
      invRawFiles = Object.values(invRaw.versions[invRaw.head].state).flat();
    });

    it("can read inventory", async function () {
      let inv = await object.getInventory();
      assert.deepStrictEqual(object.id, invRaw.id);
      assert.strictEqual(inv.toString(), JSON.stringify(invRaw, null, 2));
      let files = [];
      for (let f of inv.files()) {
        files.push(f.logicalPath);
      }
      assert.deepStrictEqual(files, invRawFiles);

    });

    it("can list files", async function () {
      let files = [...await object.files()].map(f => f.logicalPath);
      assert.deepStrictEqual(files, invRawFiles);
    });
    //list non existant object

    it("can read a file as string", async function () {
      let actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'), 'utf8');
      let content = await object.getFile('foo/bar.xml').asString();
      assert.equal(content, actualContent);
    });
    it("can read a file as buffer", async function () {
      let actualContent = await fs.promises.readFile(path.join(object.root, 'v1/content/image.tiff'));
      let content = await object.getFile('image.tiff').asBuffer();
      assert.equal(content.compare(actualContent), 0);
    });
    it("can read a file as stream", async function () {
      let actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'));
      //fileContent['empty2.txt'] = await fs.promises.readFile(path.join(config.root, 'v1/content/empty.txt'));
      // for (let f of await object.files()) {
      //   let content = await object.getAsBuffer(f);
      //   assert.equal(content.compare(fileContent[f.logicalPath]), 0);
      // }
      let stream = await object.getFile('foo/bar.xml').asStream();
      let buffers = [];
      for await (const data of stream) buffers.push(/** @type {Buffer} */(data));
      let content = Buffer.concat(buffers);
      assert.equal(content.compare(actualContent), 0);
    });
    it("can read a file as web stream", async function () {
      let actualContent = await fs.promises.readFile(path.join(object.root, 'v2/content/foo/bar.xml'));
      let stream = await object.getFile('foo/bar.xml').stream();
      let buffers = [];
      for await (const data of stream) buffers.push(/** @type {Buffer} */(data));
      let content = Buffer.concat(buffers);
      assert.equal(content.compare(actualContent), 0);
    });
  });

  describe("update", function () {
    let datadir = path.join(__dirname, 'test-data');
    let tempdir = path.join(datadir, 'temp');
    /** @type {OcflObject} */
    let objectx;

    function createObject(id, useWorkspace, ocflVersion) {
      let config = { id, root: path.join(tempdir, id), ocflVersion };
      if (useWorkspace) config.workspace = config.root + '-tmp';
      return ocfl.object(config);
    }

    before(async function () {
      // create temp dir
      await fs.promises.mkdir(tempdir, { recursive: true });
      objectx = createObject('object-x', true);
    });

    it("can detect error of unfinished operations", async function () {
      let ow = createObject('object-we1', true);
      await ow.update(async t => t.write('a.txt', 'a'));
      let p1 = ow.update(t => { // missing async
        // wrong, must use await
        t.write('test.txt', 'test');
      });
      await assert.rejects(p1);
      ow = createObject('object-we2', true);
      let p2 = ow.update(async (t) => {
        // wrong, must use await or return as a promise
        t.write('test.txt', 'test');
      });
      await assert.rejects(p2);
    });

    it("can clean up after error", async function () {
      let o = createObject('object-we3', true);
      await assert.rejects(fs.promises.access(o.workspace));
      try {
        await o.update(async t => {
          await t.write('test.txt', 'test');
          await fs.promises.access(o.workspace);
          throw new Error('test');
        });
      } catch (e) {}
      await assert.rejects(fs.promises.access(o.workspace));
      await assert.rejects(fs.promises.access(o.root));
    });

    it("does not allow nested objects", async function () {
      let o = createObject('object-we4', true);
      await o.update(async t => {
        await t.write('test.txt', 'test');
      });
      assert.strictEqual(await fs.promises.readFile(path.join(o.root, 'v1/content/test.txt'), 'utf8'), 'test');
      let o1 = createObject('object-we4/object-we5', true);
      let o2 = createObject('object-we4/test/object-we5', true);
      await assert.rejects(o1.update(async t => t.write('test.txt', 'test')));
      await assert.rejects(o2.update(async t => t.write('test.txt', 'test')));
    });

    for (let useWorkspace of [true, false]) {
      for (let ocflVersion of ocfl.OCFL_VERSIONS) {
        it(`can create correct namaste and inventory, with${useWorkspace ? '' : 'out'} workspace, with version ${ocflVersion}`, async function () {
          objcount++;
          let o = createObject('object-' + objcount, useWorkspace, ocflVersion);
          let content = 'test';
          let commitInfo = { message: 'test commit', user: { name: 'john', address: 'john@test.com' } };
          let hash = hasha(content, { algorithm: 'sha512' });
          await o.update(async t => {
            await t.write('test.txt', content);
            await t.commit(commitInfo);
          });
          let inventory = await o.getInventory();
          // namaste
          assert.strictEqual(`ocfl_object_${ocflVersion}\n`, await fs.promises.readFile(path.join(o.root, `0=ocfl_object_${ocflVersion}`), 'utf8'));
          // inventory
          let invstr = await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8');
          let inv = JSON.parse(invstr);
          //assert.strictEqual(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'), inventory.toString());
          assert.strictEqual(inv.id, 'object-' + objcount);
          assert.strictEqual(inv.digestAlgorithm, 'sha512');
          assert.strictEqual(inv.type, `https://ocfl.io/${ocflVersion}/spec/#inventory`);
          assert.strictEqual(inv.head, 'v1');
          assert.strictEqual(inv.manifest[hash][0], 'v1/content/test.txt');
          assert.strictEqual(inv.versions.v1.created, inventory.created);
          assert.strictEqual(inv.versions.v1.message, inventory.message);
          assert.strictEqual(inv.versions.v1.user.name, inventory.user?.name);
          assert.strictEqual(inv.versions.v1.state[hash][0], 'test.txt');
          // sidecar
          let sidecar = await fs.promises.readFile(path.join(o.root, 'inventory.json.sha512'), 'utf8');
          let invhash = await hasha.fromFile(path.join(o.root, 'inventory.json'), { algorithm: 'sha512' });
          assert.strictEqual(sidecar, invhash + ' inventory.json');

          //await fs.promises.rm(o.root, { recursive: true, force: true });
        });

      }
    }

    it("can write string, buffer, and stream to file", async function () {
      let content = await fs.promises.readFile(path.join(datadir, 'test_input.txt'));
      await objectx.update(async t => {
        // text
        await t.write('test.txt', content.toString());
        // buffer
        await t.write('a/test.txt', content);
        // stream
        await t.write('b/test.txt', fs.createReadStream(path.join(datadir, 'test_input.txt')));
      });
      let hash = hasha(content, { algorithm: 'sha512' });
      // inventory
      let inv = JSON.parse(await fs.promises.readFile(path.join(objectx.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inv.head, 'v1');
      assert.strictEqual(inv.manifest[hash][0], 'v1/content/test.txt');
      assert.strictEqual(inv.manifest[hash].length, 1);

      // content
      assert.strictEqual(content.toString(), await fs.promises.readFile(path.join(objectx.root, 'v1/content/test.txt'), 'utf8'));
      await assert.rejects(fs.promises.readFile(path.join(objectx.root, 'v1/content/a/test.txt'), 'utf8'));
      await assert.rejects(fs.promises.readFile(path.join(objectx.root, 'v1/content/b/test.txt'), 'utf8'));
    });

    it("can import and copy files", async function () {
      let f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-minimal/v1/file.txt');
      let f2 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
      await objectx.update(async t => {
        // file
        await assert.rejects(t.import(f1, '')); // target path cannot be empty string
        await t.import(f1);
        // directory
        await t.import(f2, '');
        await t.copy('foo', 'foo2');
      });
      let inv = JSON.parse(await fs.promises.readFile(path.join(objectx.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inv.head, 'v2');
      await validateFile(objectx, f1, 'file.txt');
      await validateFile(objectx, path.join(f2, 'foo/bar.xml'), 'foo/bar.xml');
      await validateFile(objectx, path.join(f2, 'foo/bar.xml'), 'foo2/bar.xml');
      await validateFile(objectx, path.join(f2, 'empty2.txt'), 'empty2.txt');
      await validateFile(objectx, path.join(f2, 'image.tiff'), 'image.tiff');
    });

    it("can rename files", async function () {
      let inv = await objectx.getInventory();
      let d1 = inv.getDigest('empty2.txt');
      let d2 = inv.getDigest('foo2/bar.xml');
      await objectx.update(async t => {
        // file
        await t.rename('empty2.txt', 'empty.txt');
        // directory
        await t.rename('foo2', 'bar');
      });
      inv = await objectx.getInventory();
      assert.strictEqual(inv.head, 'v3');
      assert.strictEqual(d1, inv.getDigest('empty.txt'));
      assert.strictEqual(d2, inv.getDigest('bar/bar.xml'));
      assert.ok(!inv.getDigest('empty2.txt'));
      assert.ok(!inv.getDigest('foo2/bar.xml'));
    });

    it("can remove files", async function () {
      let c1 = await objectx.count();
      await objectx.update(async t => {
        // file
        await t.remove('test.txt');
        // directory
        await t.remove('bar');
      });
      let c2 = await objectx.count();
      let inv = await objectx.getInventory();
      assert.strictEqual(inv.head, 'v4');
      assert.strictEqual(c2, c1 - 2);
      await assert.rejects(objectx.getFile('test.txt').asString());
      await assert.rejects(objectx.getFile('bar/bar.xml').asString());
    });

    it("can reinstate files", async function () {
      await objectx.update(async t => {
        // file
        await t.reinstate('test.txt', 'v3');
        // directory
        await t.reinstate('bar', 'v3');
      });
      //console.log([...(await objectx.files())].map(f => f.logicalPath));
      let inv = await objectx.getInventory();
      let d1 = inv.getDigest('test.txt', 'v3');
      let d2 = inv.getDigest('bar/bar.xml', 'v3');
      assert.strictEqual(inv.head, 'v5');
      assert.strictEqual(inv.getDigest('test.txt'), d1);
      assert.strictEqual(inv.getDigest('bar/bar.xml'), d2);
      await validateFile(objectx, path.join(datadir, 'test_input.txt'), 'test.txt');
      await validateFile(objectx, path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3/foo/bar.xml'), 'bar/bar.xml');
    });

    it("can update using replace mode", async function () {
      await objectx.update(async t => {
        // file
        await t.import(path.join(datadir, 'test_input.txt'));
        // directory
        await t.import(path.join(datadir, 'sample_dir'));
      }, 'REPLACE');
      let inv = await objectx.getInventory();
      assert.strictEqual(inv.head, 'v6');
      let files = [...await objectx.files()].map(f => f.logicalPath).sort();
      assert.deepStrictEqual(files, ['test_input.txt', 'sample_dir/data1', 'sample_dir/data2'].sort());
      await assert.doesNotReject(fs.promises.access(path.join(objectx.root, 'v6')));
    });

    it("should only add actual file content if it does not exist", async function () {
      await objectx.update(async t => {
        await t.import(path.join(datadir, 'test_input.txt'));
        await t.import(path.join(datadir, 'test_input.txt'), 'test2.txt');
      });
      let inv = await objectx.getInventory();
      assert.strictEqual(inv.head, 'v7');
      await assert.doesNotReject(fs.promises.access(path.join(objectx.root, 'v1/content/test.txt')));
      await assert.rejects(fs.promises.access(path.join(objectx.root, 'v7/content/test_input.txt')));
      await assert.rejects(fs.promises.access(path.join(objectx.root, 'v7/content/test2.txt')));
    });

    it("should only create new version if there is actual changes", async function () {
      await objectx.update(async t => {
        await t.import(path.join(datadir, 'test_input.txt'));
      });
      let inv = await objectx.getInventory();
      let files = [...await objectx.files()].map(f => f.logicalPath).sort();
      assert.strictEqual(inv.head, 'v7');
      await assert.rejects(fs.promises.access(path.join(objectx.root, 'v8')));
    });

    it("can correctly create versions", async function () {
      let f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
      let o = createObject('object-version-1', true);
      let c;
      await o.update(async t => {
        await t.write('test', 'test');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v1/content/test'), 'utf8');
      assert.strictEqual(c, 'test');
      assert.strictEqual(await o.getFile('test').asString(), 'test');
      await o.update(async t => {
        await t.write('test', 'testv2');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v2/content/test'), 'utf8');
      assert.strictEqual(c, 'testv2');
      assert.strictEqual(await o.getFile('test').asString(), 'testv2');
      await o.update(async t => {
        await t.write('test', 'test');
      });
      //console.log(o._inventory.latest.toString());
      //console.log(o._inventory.v3.toString());
      await assert.rejects(fs.promises.readFile(path.join(o.root, 'v3/content/test'), 'utf8'));
      assert.strictEqual(await o.getFile('test').asString(), 'test');
      await o.update(async t => {
        await t.write('test', 'testv4');
      });
      c = await fs.promises.readFile(path.join(o.root, 'v4/content/test'), 'utf8');
      assert.strictEqual(c, 'testv4');
      assert.strictEqual(await o.getFile('test').asString(), 'testv4');
    });

    it("can add a directory without using transaction directly", async function () {
      let f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
      let o = createObject('object-import-1', true);
      await o.import(f1);
      let inv = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inv.head, 'v1');
      await validateFile(o, path.join(f1, 'foo/bar.xml'), 'foo/bar.xml');
      await validateFile(o, path.join(f1, 'empty2.txt'), 'empty2.txt');
      await validateFile(o, path.join(f1, 'image.tiff'), 'image.tiff');
    });

    it("can add directories without using transaction directly", async function () {
      let f1 = path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3');
      let f2 = path.join(datadir, 'fixtures/1.1/content/spec-ex-diff-paths/v1');
      let o = createObject('object-import-2', true);
      await o.import([f1, f2]);
      let inv = JSON.parse(await fs.promises.readFile(path.join(o.root, 'inventory.json'), 'utf8'));
      assert.strictEqual(inv.head, 'v1');
      await validateFile(o, path.join(f1, 'foo/bar.xml'), 'foo/bar.xml');
      await validateFile(o, path.join(f1, 'empty2.txt'), 'empty2.txt');
      await validateFile(o, path.join(f1, 'image.tiff'), 'image.tiff');
      await validateFile(o, path.join(f2, 'a file.wxy'), 'a file.wxy');
      await validateFile(o, path.join(f2, 'another file.xyz'), 'another file.xyz');
    });

    //@todo: check delete, rename, reinstate non existant logical path

    after(async function () {
      // delete temp dir
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
};


//ocfl.OcflExtension.register(require('ocfl-extensions'));
//const d = require('ocfl-extension-dummy');
