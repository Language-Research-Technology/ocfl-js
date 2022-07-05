const assert = require('assert');
const { OcflStore } = require('../index.js');

class OcflTest1Store extends OcflStore {
}

class OcflTest2Store extends OcflStore {
  static instances = new Map();      
}

describe("Subclassing OcflStore class", function () {
  it("always get new instance if instances property is not included", function () {
    let s1 = OcflTest1Store.getInstance();
    let s2 = OcflTest1Store.getInstance();
    assert.ok(s1 instanceof OcflTest1Store);
    assert.notStrictEqual(s1, s2);
  });
  it("always get same instance if options are the same", function () {
    let options = {};
    let s1 = OcflTest2Store.getInstance();
    let s2 = OcflTest2Store.getInstance();
    assert.ok(s1 instanceof OcflTest2Store);
    assert.strictEqual(s1, s2);
    s1 = OcflTest2Store.getInstance(options);
    s2 = OcflTest2Store.getInstance(options);
    assert.strictEqual(s1, s2);
    s1 = OcflTest2Store.getInstance(options);
    s2 = OcflTest2Store.getInstance({});
    assert.notStrictEqual(s1, s2);
  });
});