"use strict";

const assert = require("assert");
const { createError } = require("../lib/validation.js");

describe("validation.createError", function () {
  it("uses the spec message for the given code", function () {
    const first = createError(1, '/obj');
    assert.equal(first.code, 'E001');
    assert.match(first.description, /^The OCFL Object Root must not contain files or directories/);

    const e = createError(6, '/obj');
    assert.equal(e.code, 'E006');
    assert.match(e.description, /dvalue MUST be ocfl_object_/);
    assert.equal(e.path, '/obj');
  });
});
