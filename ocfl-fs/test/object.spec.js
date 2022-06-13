//@ts-check
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ocfl = require('../lib/object');

describe("OcflObjectFs class", function () {
  before(function () {
    // runs once before the first test in this block
    this.ocfl = ocfl;
  });

  // it("constructor", function() {
  //   console.log(this.ocfl);
  //   assert.strictEqual(DIGEST.size(), 2);
  //   assert.strictEqual(DIGEST_FIXITY.size(), 5);
  // });

  describe('Private methods', function() {
    /** @type {ocfl.OcflObjectFs} */
    var o;
    before(function () {
      o = new ocfl.OcflObjectFs({root: __dirname});
    });

    it("_exists", async function () {
      assert.equal(await o._exists(''), true);
      assert.equal(await o._exists('object.spec.js'), true);
      assert.equal(await o._exists('a'), false);
    });

    it("_createDir", async function () {
      var p1 = await o._createDir('a/b/c');
      assert.equal(p1, path.join(__dirname, 'a'));
      var p2 = await o._createDir('a/b/c/d/e');
      assert.equal(p2, path.join(__dirname, 'a/b/c/d'));
      await fs.promises.rm(p1, { recursive: true, force: true });
      // assert.equal(await o._exists('object.spec.js'), true);
      // assert.equal(await o._exists('a'), false);
    });

  });
  require('ocfl-tests/object.spec')(ocfl.createObject);
});

