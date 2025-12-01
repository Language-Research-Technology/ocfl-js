//@ts-check

/**
 * Test ES module import export
 */
import assert from 'assert';
import ocfl from '@ocfl/ocfl';
import {OcflObject} from '@ocfl/ocfl';

describe("ES module import", function () {
  it("can use default import", function() {
    assert.ok(ocfl.OcflObject);
    assert.ok(ocfl.OcflStorage);
    assert.ok(ocfl.OcflStorageImpl);
    
  });
});
