import assert from 'node:assert';
import { extensions } from '../../src/index.ts';

const { HashAndIdNTupleStorageLayout } = extensions;

import { OcflDigest } from '../../src/digest.ts';

describe('HashAndIdNTupleStorageLayout class', () => {
  before(async () => {
    await OcflDigest.initSync('sha256');
    await OcflDigest.initSync('md5');
  });

  it('can map valid id with default config', () => {
    const layout = new HashAndIdNTupleStorageLayout();
    const ids = [
      ['object-01', '3c0/ff4/240/object-01'],
      ['..hor/rib:le-$id', '487/326/d8c/%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  it('can map valid id with tupleSize=2 and numberOfTuples=0', () => {
    const layout = new HashAndIdNTupleStorageLayout({ digestAlgorithm: 'md5', tupleSize: 2, numberOfTuples: 15 });
    const ids = [
      ['object-01', 'ff/75/53/44/92/48/5e/ab/b3/9f/86/35/67/28/88/object-01'],
      ['..hor/rib:le-$id', '08/31/97/66/fb/6c/29/35/dd/17/5b/94/26/77/17/%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  it('rejects a digestAlgorithm that is not lowercase', () => {
    assert.throws(() => new HashAndIdNTupleStorageLayout({ digestAlgorithm: 'MD5' }), { message: 'Invalid digestAlgorithm' });
  });

  it('rejects an unknown digestAlgorithm', () => {
    assert.throws(() => new HashAndIdNTupleStorageLayout({ digestAlgorithm: 'sha3' }), { message: 'Invalid digestAlgorithm' });
  });

  it('can map valid id with tupleSize=0 and numberOfTuples=0', () => {
    const layout = new HashAndIdNTupleStorageLayout({ digestAlgorithm: 'sha256', tupleSize: 0, numberOfTuples: 0 });
    const ids = [
      ['object-01', 'object-01'],
      ['..hor/rib:le-$id', '%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });
});
