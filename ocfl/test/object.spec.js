import assert from 'node:assert';
import { OcflObject } from '../src/object.ts';

describe('OcflObject class', () => {
  it('can not be instantiated without root', () => {
    // @ts-expect-error
    assert.throws(() => new OcflObject());
  });
  // it("can not be instantiated directly", function() {
  //   assert.throws(()=>new OcflObject({root: '/tmp/ocfl-js-test'}));
  // });
});
