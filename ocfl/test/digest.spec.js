//@ts-check
"use strict";

const assert = require("assert");
const {createStreamThrough, digestSync} = require("../lib/digest.js").OcflDigest;
const Readable = require('stream').Readable;

describe("digest", function () {
  describe("createStreamThrough", function() {
    let inputData = "This Oxford Common File Layout (OCFL) specification describes an application-independent approach to the storage of digital objects in a structured, transparent, and predictable manner. It is designed to promote long-term access and management of digital objects within digital repositories"
    let controlDigest = digestSync('sha512', inputData);
    function createReadable(encoding) {
      let r = new Readable({highWaterMark:2, encoding, read: ()=>{}});
      let i = 0;
      for (let c of inputData) {
        setTimeout(()=>r.push(c), ++i * 1);
      }
      setTimeout(()=>r.push(null), ++i * 1);
      return r;
    }
    it("can be piped from readable stream with string chunk", async function() {
      let r = createReadable('utf8');
      let hs = createStreamThrough('sha512', {encoding: 'utf8'});
      r.pipe(hs);
      let outputData = '';
      for await (const chunk of hs) {
        outputData += chunk;
      }
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(controlDigest, hs.digest());
    });
    it("can be piped from readable stream with buffer chunk", async function() {
      let r = createReadable();
      let hs = createStreamThrough();
      r.pipe(hs);
      let buffers = [];
      for await (const chunk of hs) {
        buffers.push(chunk);
      }
      let outputData = Buffer.concat(buffers).toString('utf8');
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(controlDigest, hs.digest());
    });

  });

});