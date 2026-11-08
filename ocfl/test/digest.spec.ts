import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { OcflDigest } from '../src/digest.ts';
import type { CommonHasher } from '../src/types.ts';

describe('OcflDigest', () => {
  const inputData =
    'This Oxford Common File Layout (OCFL) specification describes an application-independent approach to the storage of digital objects in a structured, transparent, and predictable manner. It is designed to promote long-term access and management of digital objects within digital repositories';
  const controlDigest = createHash('sha512').update(inputData).digest('hex');

  function createReadable(encoding?: BufferEncoding) {
    const r = new Readable({ highWaterMark: 2, encoding, read: () => {} });
    let i = 0;
    for (const c of inputData) {
      setTimeout(() => r.push(c), ++i * 1);
    }
    setTimeout(() => r.push(null), ++i * 1);
    return Readable.toWeb(r);
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
      await r.pipeTo(hs);
      assert.strictEqual(hs.digest(), controlDigest);
    });
    it('can be digest multiple algorithms', async () => {
      const r = createReadable();
      const hs = await OcflDigest.createStream(['sha512']);
      await r.pipeTo(hs);
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

  describe('digestSync', () => {
    const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

    function fixedHasherFactory(digest: string): () => Promise<CommonHasher> {
      return async () => {
        const hasher = { digestSize: 1, init: () => hasher, update: () => hasher, digest: () => digest } as unknown as CommonHasher;
        return hasher;
      };
    }

    it('digests with a built-in algorithm repeatedly without initSync', () => {
      assert.strictEqual(OcflDigest.digestSync('sha256', 'abc'), SHA256_OF_ABC);
      assert.strictEqual(OcflDigest.digestSync('sha256', 'abc'), SHA256_OF_ABC);
    });

    it('still accepts initSync for a built-in algorithm', async () => {
      await OcflDigest.initSync('sha256');
      assert.strictEqual(OcflDigest.digestSync('sha256', 'abc'), SHA256_OF_ABC);
    });

    it('requires initSync for a registered algorithm', async () => {
      OcflDigest.registerHasherFactory('custom', fixedHasherFactory('custom-digest'));
      assert.throws(() => OcflDigest.digestSync('custom', 'abc'), /is not initialized/);
      await OcflDigest.initSync('custom');
      assert.strictEqual(OcflDigest.digestSync('custom', 'abc'), 'custom-digest');
    });

    it('requires initSync for a factory that replaces a built-in algorithm already used', async () => {
      OcflDigest.digestSync('sha1', 'abc');
      OcflDigest.registerHasherFactory('sha1', fixedHasherFactory('replaced-digest'));
      assert.throws(() => OcflDigest.digestSync('sha1', 'abc'), /is not initialized/);
      await OcflDigest.initSync('sha1');
      assert.strictEqual(OcflDigest.digestSync('sha1', 'abc'), 'replaced-digest');
    });

    it('keeps the hasher from initSync when its factory is replaced afterwards', async () => {
      await OcflDigest.initSync('md5');
      OcflDigest.registerHasherFactory('md5', fixedHasherFactory('replaced-digest'));
      assert.strictEqual(OcflDigest.digestSync('md5', 'abc'), '900150983cd24fb0d6963f7d28e17f72');
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
      const hash2 = `${new TextEncoder().encode(inputData).length}`;
      assert.strictEqual(hash, hash2);
    });
  });
});
