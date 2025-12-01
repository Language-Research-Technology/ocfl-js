"use strict";
//@ts-check

const assert = require("assert");
const OcflObject = require("../lib/object.js").OcflObject;


describe("OcflObject class", function () {
  it("can not be instantiated without root", function() {
    // @ts-ignore
    assert.throws(()=>new OcflObject());
  });
  // it("can not be instantiated directly", function() {
  //   assert.throws(()=>new OcflObject({root: '/tmp/ocfl-js-test'}));
  // });

});

async function fn() {
  (await (new OcflObject()).getInventory())
}
