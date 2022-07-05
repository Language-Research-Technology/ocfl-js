const assert = require('assert');
const { OcflExtension } = require('../index.js');

describe("OcflExtension class", function () {
  it("can register new extension", function () {
    let len = OcflExtension.classes.length;
    class TestExt extends OcflExtension {
      static get NAME() { return '9999-test-extension' };
    };
    TestExt.register();
    assert.strictEqual(OcflExtension.class('9999-test-extension'), TestExt);
    assert.strictEqual(OcflExtension.classes.length, len + 1); 
    
  });
});

