"use strict";

const assert = require("assert");
const {Enum} = require("../lib/enum.js");


describe("Enum class", function () {
  class DIGEST extends Enum {
    static sha256 = new this('sha256');
    static sha512 = new this('sha512');
  };
  
  class DIGEST_FIXITY extends DIGEST {
    static md5 = new this('md5');
    static sha1 = new this('sha1');
    static blake2b512 = new this('blake2b-512');
  };
  
  class UPDATE_MODE extends Enum {
    static REPLACE = new this();
    static MERGE = new this();
    static {this.freeze()};
  }
  //UPDATE_MODE[Symbol.iterator]();
  //DIGEST_FIXITY._length;

  it("can get enum from string value", function() {
    assert.strictEqual(DIGEST_FIXITY.md5, DIGEST_FIXITY.of('md5'));
    assert.strictEqual(DIGEST_FIXITY.sha1, DIGEST_FIXITY.of('sha1'));
    assert.strictEqual(DIGEST_FIXITY.sha256, Enum.of('sha256', DIGEST_FIXITY));
    assert.strictEqual(DIGEST_FIXITY.sha512, Enum.of('sha512', DIGEST_FIXITY));
    assert.strictEqual(DIGEST_FIXITY.blake2b512, DIGEST_FIXITY.of('blake2b-512'));
    assert.strictEqual(undefined, DIGEST_FIXITY.of('a'));
  });

  it("can inherit other enum correctly", function() {
    assert.strictEqual(DIGEST_FIXITY.sha256, DIGEST.sha256);
    assert.strictEqual(DIGEST_FIXITY.sha512, DIGEST.sha512);
  });

  it("can get name", function() {
    assert.strictEqual(DIGEST_FIXITY.sha256.name, "sha256");
    assert.strictEqual(DIGEST_FIXITY.sha512.name, "sha512");
    assert.strictEqual(DIGEST_FIXITY.md5.name, "md5");
    assert.strictEqual(DIGEST_FIXITY.sha1.name, "sha1");
    assert.strictEqual(DIGEST_FIXITY.blake2b512.name, "blake2b512");
  });

  it("can get ordinal", function() {
    assert.strictEqual(DIGEST_FIXITY.sha256.ordinal, 0);
    assert.strictEqual(DIGEST_FIXITY.sha512.ordinal, 1);
    assert.strictEqual(DIGEST_FIXITY.md5.ordinal, 2);
    assert.strictEqual(DIGEST_FIXITY.sha1.ordinal, 3);
    assert.strictEqual(DIGEST_FIXITY.blake2b512.ordinal, 4);
  });

  it("can not modify frozen enum instance", function() {
    assert.throws(()=>UPDATE_MODE.a = 1, Error);
    assert.throws(()=>UPDATE_MODE.REPLACE.a = 1, Error);
  });

  it("can calculate number of constants", function() {
    assert.strictEqual(DIGEST.size(), 2);
    assert.strictEqual(DIGEST_FIXITY.size(), 5);
  });

  it("can be iterated with for of loop", function() {
    let names = [];
    for (let e of DIGEST_FIXITY) {
      names.push(e.name);
    }
    let names2 = Array.from(DIGEST_FIXITY).map(e => e.name);
    assert.deepEqual(names, names2);
    assert.deepEqual(names, ['sha256', 'sha512', 'md5', 'sha1', 'blake2b512']);
  });

});