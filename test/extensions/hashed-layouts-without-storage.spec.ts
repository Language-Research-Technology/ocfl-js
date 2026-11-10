import assert from 'node:assert';
import { describe, it } from 'node:test';
import { storageLayout } from '../../src/index.ts';

const DIGESTS_OF_OBJECT_01 = {
  md5: 'ff75534492485eabb39f86356728884e',
  sha1: 'b2773f2fd4fff0bc1e6b714ec9d2fdb29f01a2f0',
  sha256: '3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4',
  sha512: 'd3601f87119afe50380069e8dbdb3907c00a87ba98d2acf608b43b07f0b7271955fd3b9f9edcbf2be955d49f76e513d9b87895c131d6b609c149dfbc55b3aed4',
  'sha512/256': '465229f4b15300f5584727f10251f26fce82088d42272d0a594cb285f565c44b',
  'blake2b-512': '860ef803e364030bdc23bdc27a6eff83c472b554653c21513f0bdec3d240d944440fed57af380941c85d669e10b9d38b3309e164d309afae3b528f87bd2b3021',
  crc32: '0420a973',
  size: '9',
};

const MAX_TUPLE_SIZE = 32;

describe('hashed storage layouts without a loaded storage', () => {
  for (const [digestAlgorithm, digest] of Object.entries(DIGESTS_OF_OBJECT_01)) {
    const tuple = digest.slice(0, MAX_TUPLE_SIZE);
    const config = { digestAlgorithm, tupleSize: tuple.length, numberOfTuples: 1 };

    it(`0003 maps an id with ${digestAlgorithm}`, () => {
      assert.strictEqual(storageLayout({ extensionName: '0003-hash-and-id-n-tuple-storage-layout', ...config }).map('object-01'), `${tuple}/object-01`);
    });

    it(`0004 maps an id with ${digestAlgorithm}`, () => {
      assert.strictEqual(storageLayout({ extensionName: '0004-hashed-n-tuple-storage-layout', ...config }).map('object-01'), `${tuple}/${digest}`);
    });
  }
});
