//@ts-check

import ocfl, { OcflObject } from '@ocfl/ocfl';
/**
 * Test ES module import export
 */
import assert from 'assert';

describe('ES module import', () => {
  it('can use default import', () => {
    assert.ok(ocfl.OcflObject);
    assert.ok(ocfl.OcflStorage);
    assert.ok(ocfl.OcflStorageImpl);
  });
});
