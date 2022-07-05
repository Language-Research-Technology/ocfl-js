const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { OcflFsStore } = require("../lib/store");

describe("OcflFsStore", function () {
    var store = new OcflFsStore();
    // before(function () {
    //   store = new OcflFsStore();
    // });

    it("exists", async function () {
      assert.equal(await store.exists(__dirname), true);
      assert.equal(await store.exists(path.join(__dirname, 'object.spec.js')), true);
      assert.equal(await store.exists('a'), false);
    });

    it("createDir", async function () {
      var p1 = await store.mkdir(path.join(__dirname,'a/b/c'));
      assert.equal(p1, path.join(__dirname, 'a'));
      var p2 = await store.mkdir(path.join(__dirname,'a/b/c/d/e'));
      assert.equal(p2, path.join(__dirname, 'a/b/c/d'));
      await fs.promises.rm(p1, { recursive: true, force: true });
      // assert.equal(await o._exists('object.spec.js'), true);
      // assert.equal(await o._exists('a'), false);
    });

});