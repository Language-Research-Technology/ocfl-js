//@ts-check
"use strict";

const assert = require("assert");
const error = require("../lib/error.js");

describe("error.NotImplementedError", function () {
  it("can show correct name and message", async function() {
    try {
      throw new error.NotImplementedError('test');
    } catch (error) {
      assert.equal(error.name, 'NotImplementedError');
      assert.equal(error.message, 'Method test has not been implemented');
    }
  });
});