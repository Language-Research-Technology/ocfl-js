//@ts-check
"use strict";

const assert = require("assert");
const digest_ = require("../lib/digest.js");
const { OcflDigest } = require("../lib/digest.js");
const Readable = require('stream').Readable;
const { createHash } = require("node:crypto");
const { testSymbol } = require('../lib/utils.js');

describe("OcflDigest", function () {
  const inputData = "This Oxford Common File Layout (OCFL) specification describes an application-independent approach to the storage of digital objects in a structured, transparent, and predictable manner. It is designed to promote long-term access and management of digital objects within digital repositories"
  const controlDigest = createHash('sha512').update(inputData).digest('hex');

  /**
   * @param {*} [encoding]
   */
  function createReadable(encoding) {
    let r = new Readable({ highWaterMark: 2, encoding, read: () => { } });
    let i = 0;
    for (let c of inputData) {
      setTimeout(() => r.push(c), ++i * 1);
    }
    setTimeout(() => r.push(null), ++i * 1);
    return /** @type {ReadableStream} */ (Readable.toWeb(r));
  }

  describe("digest", async function () {
    it("can calculate hash from a string", async function () {
      const hash = await OcflDigest.digest('sha512', inputData);
      assert.strictEqual(controlDigest, hash);
    });
  });

  describe("createStream", async function () {
    it("can be used as stream", async function () {
      const hs = await OcflDigest.createStream('sha512');
      const w = hs.getWriter();
      w.write(inputData);
      w.close();
      assert.strictEqual(controlDigest, hs.digest());
    });
    it("can be piped from readable stream", async function () {
      const r = createReadable();
      const hs = await OcflDigest.createStream('sha512');
      const rs = await r.pipeTo(hs);
      assert.strictEqual(controlDigest, hs.digest());
    });
  });

  describe("createStreamThrough", async function () {
    it("can be piped from readable stream with string chunk", async function () {
      const r = createReadable('utf8');
      const hs = await OcflDigest.createStreamThrough('sha512');
      const rs = r.pipeThrough(hs);
      let outputData = '';
      for await (const chunk of rs) {
        outputData += chunk;
      }
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(controlDigest, hs.digest());
    });
    it("can be piped from readable stream with buffer chunk", async function () {
      const r = createReadable();
      const hs = await OcflDigest.createStreamThrough('sha512');
      const rs = r.pipeThrough(hs);
      let buffers = [];
      for await (const chunk of rs) {
        buffers.push(chunk);
      }
      let outputData = Buffer.concat(buffers).toString('utf8');
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(controlDigest, hs.digest());
    });
  });

  describe("digest instances", async function () {
    it("can reuse the same hash instances", async function () {
      const cache = digest_[testSymbol].algorithms;
      let hs = await OcflDigest.createStream('sha512');
      hs.update(inputData);
      hs.digest();
      const h1 = cache['sha512'][0];
      hs = await OcflDigest.createStream('sha512');
      hs.update(inputData);
      hs.digest();
      const h2 = cache['sha512'][0];
      assert.strictEqual(cache['sha512'].length, 1);
      assert.strictEqual(h1, h2);
    });
    it("can creating multiple of the same hash instances", async function () {
      const p = [];
      for (let i = 0; i < 10; ++i) {
        const hs = await OcflDigest.createStream('sha512');
        p.push(hs);
      }
      for (const hs of p) {
        hs.update(inputData);
        hs.digest();
      }
      const cache = digest_[testSymbol].algorithms;
      assert.strictEqual(cache['sha512'].length, 10);
      assert.notEqual(cache['sha512'][0], cache['sha512'][1]);
      //assert.strictEqual(controlDigest, hash);
    });
  });

});
