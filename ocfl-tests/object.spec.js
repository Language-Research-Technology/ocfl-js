const assert = require("assert");
const path = require("path");
const fs = require("fs");
const hasha = require("hasha");
const { Readable } = require("node:stream");
const ocfl = require("ocfl");
const { createHash } = require('crypto');


/** @param {ocfl.createObject} createObjectImpl */
module.exports = function (createObjectImpl) {

  /** @type {ocfl.OcflObject} */
  let object;
  let objcount = 0;

  /**
   * 
   * @param {ocfl.OcflObject} object 
   * @param {string} srcPath 
   * @param {string} logicalPath 
   */
  async function validateFile(object, srcPath, logicalPath) {
    let content = await fs.promises.readFile(srcPath);
    let digest = hasha(content, { algorithm: 'sha512' });
    let inv = await object.getInventory();
    assert.strictEqual(inv.manifest[digest].length, 1);
    //console.log(inv.state[digest]);
    assert.ok(inv.state[digest].includes(logicalPath));
    assert.strictEqual(content.toString(), await object.getAsString({ digest }));
    assert.strictEqual(content.toString(), await object.getAsString({ logicalPath }));
  }

  before(function () {
    object = createObjectImpl({ root: '/data/objects/object-1' });
  });

  describe("object encapsulation", function () {
    it("cannot access protected properties", function () {
      //console.log();
      //console.log(object._getInventory);
      // @ts-ignore
      assert.equal(object._getInventory, null);
    });
  });

  describe("constructor", function () {
    it("can create new object", function () {
      let object;
      object = createObjectImpl({ root: '/data/objects/object-1' });
      assert.equal(object.root, '/data/objects/object-1');
      object = createObjectImpl({ root: '/data/objects/object-1', digestAlgorithm: "sha256", id: "object-1" });
      assert.equal(object.root, '/data/objects/object-1');
      assert.equal(object.id, 'object-1');
      assert.throws(() => {
        object = createObjectImpl({ root: '/data/objects/object-1', workspace: '/data/objects/object-1' });
      });
    });

  });

  describe("access existing object", function () {
    let config;
    let invRaw, invRawFiles;
    before(async function () {
      config = { root: path.join(__dirname, 'test-data/fixtures/1.1/good-objects/spec-ex-full') };
      object = createObjectImpl(config);
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

    it("can read files", async function () {
      let fileContent = {};
      fileContent['image.tiff'] = await fs.promises.readFile(path.join(config.root, 'v1/content/image.tiff'));
      fileContent['foo/bar.xml'] = await fs.promises.readFile(path.join(config.root, 'v2/content/foo/bar.xml'));
      fileContent['empty2.txt'] = await fs.promises.readFile(path.join(config.root, 'v1/content/empty.txt'));
      for (let f of await object.files()) {
        let content = await object.getAsBuffer(f);
        assert.equal(content.compare(fileContent[f.logicalPath]), 0);
      }
    });
  });

  describe("update", function () {
    let datadir = path.join(__dirname, 'test-data');
    let tempdir = path.join(datadir, 'temp');
    /** @type {ocfl.OcflObject} */
    let objectx;

    function createObject(id, useWorkspace, ocflVersion) {
      let config = { id, root: path.join(tempdir, id), ocflVersion };
      if (useWorkspace) config.workspace = config.root + '-tmp';
      return createObjectImpl(config);
    }

    before(async function () {
      // create temp dir
      await fs.promises.mkdir(tempdir, { recursive: true });
      objectx = createObject('object-x', true);
    });

    it("can detect error of unfinished operations", async function () {
      let ow = createObject('object-we1', true);
      let p = ow.update(t => { // missing async
        // wrong, must use await
        t.write('test.txt', 'test');
      });
      await assert.rejects(p);
      ow = createObject('object-we2', true);
      let p2 = ow.update(async (t) => {
        // wrong, must use await
        t.write('test.txt', 'test');
      });
      await assert.rejects(p2);
    });

    for (let useWorkspace of [true, false]) {
      for (let ocflVersion of ocfl.OcflConstants.OCFL_VERSIONS) {
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
          assert.strictEqual(inv.versions.v1.user.name, inventory.user.name);
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
        await assert.rejects(t.import(f1, ''));
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
      await assert.rejects(objectx.getAsString({ logicalPath: 'test.txt' }));
      await assert.rejects(objectx.getAsString({ logicalPath: 'bar/bar.xml' }));
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

    //@todo: check delete, rename, reinstate non existant logical path

    after(async function () {
      // delete temp dir
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
}


//ocfl.OcflExtension.register(require('ocfl-extensions'));
//const d = require('ocfl-extension-dummy');
