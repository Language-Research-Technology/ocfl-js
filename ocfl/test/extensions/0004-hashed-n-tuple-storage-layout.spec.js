"use strict";

const assert = require("assert");
const { HashedNTupleStorageLayout } = require('../../index').extensions;

describe("HashedNTupleStorageLayout class", function () {

  it("can use default config", function () {
    let layout = HashedNTupleStorageLayout.create();
    let cases = [
      ['object-01', '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4'],
      ['..hor/rib:le-$id', '487/326/d8c/487326d8c2a3c0b885e23da1469b4d6671fd4e76978924b4443e9e3c316cda6d']
    ];
    for (let idp of cases) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  it("can use custom config", function () {
    let layout = HashedNTupleStorageLayout.create({digestAlgorithm: "md5", tupleSize: 2, numberOfTuples: 15, shortObjectRoot: true });
    let cases = [
      ['object-01', 'ff/75/53/44/92/48/5e/ab/b3/9f/86/35/67/28/88/4e'],
      ['..hor/rib:le-$id', '08/31/97/66/fb/6c/29/35/dd/17/5b/94/26/77/17/e0']
    ];
    for (let idp of cases) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  it("can use custom config, edge case", function () {
    let layout = HashedNTupleStorageLayout.create({digestAlgorithm: "sha256", tupleSize: 0, numberOfTuples: 0, shortObjectRoot: false });
    let cases = [
      ['object-01', '3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4'],
      ['..hor/rib:le-$id', '487326d8c2a3c0b885e23da1469b4d6671fd4e76978924b4443e9e3c316cda6d']
    ];
    for (let idp of cases) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

});