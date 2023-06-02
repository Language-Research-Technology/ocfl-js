// throw error if workspace is the same as root or a subdirectory of root

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { Ocfl, OcflStorage } = require("@ocfl/ocfl");

/** 
 * @param {Ocfl} ocfl
 */
module.exports = function (ocfl, storeConfig) {
  describe("constructor", function () {
    it("can create new storage", function () {
      let storage;
      storage = ocfl.storage({ root: '/data/storage-1' }, storeConfig);
      assert.equal(storage.root, '/data/storage-1');

      assert.throws(() => {
        storage = ocfl.storage({ root: '/data/storage-1', layout: ocfl.storageLayout("test") }, storeConfig);
      });

      assert.throws(() => {
        storage = ocfl.storage({ root: '/data/storage-1', workspace: '/data/storage-1/temp' }, storeConfig);
      });
    });

  });
  describe("access existing storage", function () {
    let repo = ocfl.storage({root: path.join(__dirname, 'test-data/storage')}, storeConfig);
    let objects = [
      { root: path.join(repo.root, 'object_1'), id: 'http://example.org/minimal_no_content' }
    ];
    it("can list objects via async iterator", async function () {
      let i = 0;
      for await(let o of repo) {
        assert.strictEqual(o.root, objects[i].root);
        assert.strictEqual(o.id, undefined);
        await o.load();
        assert.strictEqual(o.id, objects[i].id);
        ++i;
      }
    });
    it("can list objects via objects() method", async function () {
      const objarr = [];
      for await(let o of repo.objects()) { objarr.push(o) }
      //const objarr = Promise.all(iter);
      assert.strictEqual(objarr.length, 1);
      assert.strictEqual(objarr[0].root, objects[0].root);

    });
    it("can retrieve object inventory", async function () {
      let o = repo.object({root:'object_1'});
      await o.load();
      assert.strictEqual(o.id, objects[0].id);
    });
  });
  describe("mutators", function () {
    let datadir = path.join(__dirname, 'test-data');
    let tempdir = path.join(datadir, 'temp');
    before(async function () {
      // create temp dir
      await fs.promises.mkdir(tempdir, { recursive: true });
    });

    it("can create new storage with default layout", async function () {
      let storage;
      storage = ocfl.storage({ root: path.join(tempdir, 'storage') }, storeConfig);
      await storage.create();
      let namaste = await fs.promises.readFile(path.join(storage.root, `0=ocfl_${storage.ocflVersion}`), 'utf8');
      // namaste
      assert.strictEqual(`ocfl_${storage.ocflVersion}\n`, namaste);
    });

    it("can create object in the storage", async function () {
      let storage;
      storage = ocfl.storage({ root: path.join(tempdir, 'storage') }, storeConfig);
      await storage.load();
      let o = storage.object('http://ocfl.io/examples/object-1');
      await o.update(async t => {
        await t.write('test.txt', 'test');
      });
      await o.import(path.join(datadir, 'fixtures/1.1/content/spec-ex-full/v3'));
      let test = await fs.promises.readFile(path.join(o.root, 'v1', 'content', 'test.txt'), 'utf8');
      assert.strictEqual(test, 'test');
      test = await fs.promises.readFile(path.join(o.root, 'v2', 'content', 'empty2.txt'), 'utf8');
      assert.strictEqual(test, '');
    });
    after(async function () {
      // delete temp dir
      await fs.promises.rm(tempdir, { recursive: true, force: true });
    });
  });
  describe("constructor", function () {
    it("can create new storage", function () {
    });
  });
};
