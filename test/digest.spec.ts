import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import * as Hashing from '../src/digest.ts';
import { DIGESTS_OF_ABC, eachDigest } from './helpers/digests-of-abc.ts';

describe('Hashing', () => {
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
      const hash = await Hashing.digest('sha512', inputData);
      assert.strictEqual(hash, controlDigest);
    });
    it('can calculate hash from a stream of byte chunks', async () => {
      assert.strictEqual(await Hashing.digest('sha512', createReadable()), controlDigest);
    });
    it('can calculate hash from a stream of string chunks', async () => {
      assert.strictEqual(await Hashing.digest('sha512', createReadable('utf8')), controlDigest);
    });
    it('rejects a chunk that is not bytes or a string', async () => {
      await assert.rejects(Hashing.digest('sha512', Readable.from([42])), /Unsupported data type: \[object Number\]/);
    });
  });

  describe('digestSync', () => {
    for (const [algorithm, expected] of eachDigest(DIGESTS_OF_ABC)) {
      it(`digests with ${algorithm} repeatedly`, () => {
        assert.strictEqual(Hashing.digestSync(algorithm, 'abc'), expected);
        assert.strictEqual(Hashing.digestSync(algorithm, 'abc'), expected);
      });
    }
  });

  describe('fixity algorithms', async () => {
    for (const [algorithm, expected] of eachDigest(DIGESTS_OF_ABC)) {
      it(`calculates ${algorithm}`, async () => {
        assert.strictEqual(await Hashing.digest(algorithm, 'abc'), expected);
      });
    }
    it('can correctly calculate BLAKE2b512', async () => {
      const hash = await Hashing.digest('blake2b-512', inputData);
      const hash2 = createHash('BLAKE2b512').update(inputData).digest('hex');
      assert.strictEqual(hash, hash2);
    });
    it('can correctly calculate sha 512/256', async () => {
      let hash = await Hashing.digest('sha512/256', inputData);
      const hash2 = createHash('sha512-256').update(inputData).digest('hex');
      assert.strictEqual(hash, hash2);
      hash = await Hashing.digest('sha512/256', new TextEncoder().encode(inputData));
      assert.strictEqual(hash, hash2);
    });
    it('can digest an ArrayBuffer and typed array views', async () => {
      const bytes = new TextEncoder().encode(inputData);
      assert.strictEqual(await Hashing.digest('sha512', bytes.buffer), controlDigest);
      assert.strictEqual(
        await Hashing.digest('sha512', new Uint16Array(bytes.buffer.slice(0, 2))),
        createHash('sha512').update(bytes.subarray(0, 2)).digest('hex'),
      );
    });
  });

  describe('isFixityAlgorithm', () => {
    for (const algorithm of Object.keys(DIGESTS_OF_ABC)) {
      it(`accepts ${algorithm}`, () => {
        assert.strictEqual(Hashing.isFixityAlgorithm(algorithm), true);
      });
    }
    for (const name of ['blake2b-256', 'SHA256', 'size', '', 'constructor', '__proto__', 'toString']) {
      it(`refuses ${JSON.stringify(name)}`, () => {
        assert.strictEqual(Hashing.isFixityAlgorithm(name), false);
      });
    }
  });
});
