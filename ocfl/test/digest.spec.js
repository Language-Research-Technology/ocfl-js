//@ts-check

const assert = require('assert');
const { OcflDigest } = require('../lib/digest.js');
const Readable = require('stream').Readable;
const { createHash } = require('node:crypto');

describe('OcflDigest', () => {
  const inputData =
    'This Oxford Common File Layout (OCFL) specification describes an application-independent approach to the storage of digital objects in a structured, transparent, and predictable manner. It is designed to promote long-term access and management of digital objects within digital repositories';
  const controlDigest = createHash('sha512').update(inputData).digest('hex');

  /**
   * @param {*} [encoding]
   */
  function createReadable(encoding) {
    const r = new Readable({ highWaterMark: 2, encoding, read: () => {} });
    let i = 0;
    for (const c of inputData) {
      setTimeout(() => r.push(c), ++i * 1);
    }
    setTimeout(() => r.push(null), ++i * 1);
    return /** @type {ReadableStream} */ (Readable.toWeb(r));
  }

  describe('digest', async () => {
    it('can calculate hash from a string', async () => {
      const hash = await OcflDigest.digest('sha512', inputData);
      assert.strictEqual(hash, controlDigest);
      const hash2 = await OcflDigest.digest(['sha512'], inputData);
      assert.strictEqual(hash2.sha512, controlDigest);
    });
  });

  describe('createStream', async () => {
    it('can be used as stream', async () => {
      const hs = await OcflDigest.createStream('sha512');
      const w = hs.getWriter();
      w.write(inputData);
      w.close();
      assert.strictEqual(hs.digest(), controlDigest);
    });
    it('can be piped from readable stream', async () => {
      const r = createReadable();
      const hs = await OcflDigest.createStream('sha512');
      const rs = await r.pipeTo(hs);
      assert.strictEqual(hs.digest(), controlDigest);
    });
    it('can be digest multiple algorithms', async () => {
      const r = createReadable();
      const hs = await OcflDigest.createStream(['sha512']);
      const rs = await r.pipeTo(hs);
      assert.strictEqual(hs.digest().sha512, controlDigest);
    });
  });

  describe('createStreamThrough', async () => {
    it('can be piped from readable stream with string chunk', async () => {
      const r = createReadable('utf8');
      const hs = await OcflDigest.createStreamThrough('sha512');
      const rs = r.pipeThrough(hs);
      let outputData = '';
      for await (const chunk of rs) {
        outputData += chunk;
      }
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(hs.digest(), controlDigest);
    });
    it('can be piped from readable stream with buffer chunk', async () => {
      const r = createReadable();
      const hs = await OcflDigest.createStreamThrough('sha512');
      const rs = r.pipeThrough(hs);
      const buffers = [];
      for await (const chunk of rs) {
        buffers.push(chunk);
      }
      const outputData = Buffer.concat(buffers).toString('utf8');
      assert.strictEqual(inputData, outputData);
      assert.strictEqual(hs.digest(), controlDigest);
    });
  });

  describe('digest algorithms', async () => {
    it('can correctly calculate BLAKE2b512', async () => {
      const hash = await OcflDigest.digest('blake2b-512', inputData);
      const hash2 = createHash('BLAKE2b512').update(inputData).digest('hex');
      assert.strictEqual(hash, hash2);
    });
    it('can correctly calculate sha 512/256', async () => {
      let hash = await OcflDigest.digest('sha512/256', inputData);
      const hash2 = createHash('sha512-256').update(inputData).digest('hex');
      assert.strictEqual(hash, hash2);
      hash = await OcflDigest.digest('sha512/256', new TextEncoder().encode(inputData));
      assert.strictEqual(hash, hash2);
    });
    it('can correctly calculate crc32', async () => {
      const hash = await OcflDigest.digest('crc32', 'a');
      assert.strictEqual(hash, 'e8b7be43');
      assert.strictEqual(await OcflDigest.digest('crc32', ''), '00000000');
    });
    it('can digest an ArrayBuffer and typed array views', async () => {
      const bytes = new TextEncoder().encode(inputData);
      assert.strictEqual(await OcflDigest.digest('sha512', bytes.buffer), controlDigest);
      assert.strictEqual(
        await OcflDigest.digest('sha512', new Uint16Array(bytes.buffer.slice(0, 2))),
        createHash('sha512').update(bytes.subarray(0, 2)).digest('hex'),
      );
    });
    it('rejects unsupported algorithms', async () => {
      await assert.rejects(OcflDigest.digest('blake2b-256', inputData), /Unsupported digest algorithm/);
    });
    it('can correctly calculate byte size', async () => {
      const hash = await OcflDigest.digest('size', inputData);
      const hash2 = '' + new TextEncoder().encode(inputData).length;
      assert.strictEqual(hash, hash2);
    });
  });
});
