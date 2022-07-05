"use strict";

const assert = require("assert");
const {FlatDirectStorageLayout} = require('../../index').extensions;

describe("FlatDirectStorageLayout class", function () {
  let layout = FlatDirectStorageLayout.create();

  it("can map valid id", function() {
    let id1 = 'object-01';
    let id2 = '..hor_rib:lé-$id';

    assert.strictEqual(layout.map(id1), id1);
    assert.strictEqual(layout.map(id2), id2);
  });

  it("can throw error for invalid id", function() {
    let id1 = 'info:fedora/object-01';
    let id2 = 'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij';

    assert.throws(()=>layout.map(id1));
    assert.throws(()=>layout.map(id2));
  });

});