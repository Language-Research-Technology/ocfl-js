"use strict";
//@ts-check

const assert = require("assert");
const OcflObject = require("../lib/object.js").OcflObject;
const OcflObjectImpl = require("../lib/object.js").OcflObjectImpl;


describe("OcflObjectImpl class", function () {
  // it("can not be instantiated without root", function() {
  //   assert.throws(()=>new OcflObject());
  // });
  it("can not be instantiated directly", function() {
    assert.throws(()=>new OcflObjectImpl({root: '/tmp/ocfl-js-test'}));
  });

});

async function fn() {
  (await (new OcflObject()).getInventory())
}
