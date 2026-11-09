import assert from 'node:assert';
import { describe, it } from 'node:test';
import ocfl from '../src/index.ts';

describe('storageLayout without a loaded storage', () => {
  it('maps an id with the 0003 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0003-hash-and-id-n-tuple-storage-layout').map('object-01'), '3c0/ff4/240/object-01');
  });

  it('maps an id with the 0004 layout', () => {
    assert.strictEqual(
      ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').map('object-01'),
      '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4',
    );
  });
});
