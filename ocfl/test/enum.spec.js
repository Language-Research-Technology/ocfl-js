"use strict";

const assert = require("assert");
const { enumeration } = require("../lib/enum.js");
const enumOf = enumeration.of;

describe("Enum class", function () {
  const DIGEST = enumeration(['sha256', 'sha512']);
  const DIGEST_FIXITY = enumeration(['md5', 'sha1', 'blake2b-512']);
  const UPDATE_MODE = enumeration(['REPLACE', 'MERGE']);
  //UPDATE_MODE[Symbol.iterator]();
  //DIGEST_FIXITY._length;

  it("can get enum from string value", function () {
    assert.strictEqual(DIGEST.sha256, enumOf(DIGEST, 'sha256'));
    assert.strictEqual(DIGEST.sha512, enumOf(DIGEST, 'sha512'));
    assert.strictEqual(DIGEST_FIXITY.md5, enumOf(DIGEST_FIXITY, 'md5'));
    assert.strictEqual(DIGEST_FIXITY.sha1, enumOf(DIGEST_FIXITY, 'sha1'));
    assert.strictEqual(DIGEST_FIXITY['blake2b-512'], enumOf(DIGEST_FIXITY, 'blake2b-512'));
    assert.strictEqual(undefined, enumOf(DIGEST_FIXITY, 'a'));
  });

  it("can check if enum contains a constant", function () {
    assert.ok(DIGEST_FIXITY[DIGEST_FIXITY.md5]);
    assert.ok(DIGEST_FIXITY[DIGEST_FIXITY.sha1]);
    assert.ok(!DIGEST[DIGEST_FIXITY.md5]);
  });

  it("can get name", function () {
    assert.strictEqual(DIGEST.sha256.name, "sha256");
    assert.strictEqual(DIGEST.sha512.name, "sha512");
    assert.strictEqual(DIGEST_FIXITY.md5.name, "md5");
    assert.strictEqual(DIGEST_FIXITY.sha1.name, "sha1");
    assert.strictEqual(DIGEST_FIXITY["blake2b-512"].name, "blake2b-512");
  });

  it("can get ordinal", function () {
    assert.strictEqual(DIGEST.sha256.ordinal, 0);
    assert.strictEqual(DIGEST.sha512.ordinal, 1);
    assert.strictEqual(DIGEST_FIXITY.md5.ordinal, 0);
    assert.strictEqual(DIGEST_FIXITY.sha1.ordinal, 1);
    assert.strictEqual(DIGEST_FIXITY["blake2b-512"].ordinal, 2);
  });

  it("can not modify frozen enum instance", function () {
    assert.throws(() => UPDATE_MODE.a = 1, Error);
    assert.throws(() => UPDATE_MODE.REPLACE.a = 1, Error);
  });

  it("can calculate number of constants", function () {
    assert.strictEqual(enumeration.size(DIGEST), 2);
    assert.strictEqual(enumeration.size(DIGEST_FIXITY), 3);
  });

  it("can be iterated with for of loop", function () {
    let names = [];
    for (let name of DIGEST_FIXITY) {
      names.push(name);
    }
    let names2 = Array.from(DIGEST_FIXITY);
    assert.deepEqual(names, names2);
    assert.deepEqual(names, ['md5', 'sha1', 'blake2b-512']);
  });

});