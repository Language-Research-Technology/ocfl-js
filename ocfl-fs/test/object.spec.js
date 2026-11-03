import ocflTests from '@ocfl/ocfl-tests';
import ocfl from '../src/index.ts';

describe('OcflObject class using OcflFsStore', () => {
  // it("constructor", function() {
  //   console.log(this.ocfl);
  //   assert.strictEqual(DIGEST.size(), 2);
  //   assert.strictEqual(DIGEST_FIXITY.size(), 5);
  // });

  ocflTests.object(ocfl);
});
