//@ts-check
"use strict";

const ocfl = require('../index');

describe("OcflObject class using OcflFsStore", function () {
  // it("constructor", function() {
  //   console.log(this.ocfl);
  //   assert.strictEqual(DIGEST.size(), 2);
  //   assert.strictEqual(DIGEST_FIXITY.size(), 5);
  // });

  require('@ocfl/ocfl-tests').object(ocfl);
});

