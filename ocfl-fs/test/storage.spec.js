import ocflTests from '@ocfl/ocfl-tests';
import ocfl from '../src/index.ts';

describe('OcflStorage class using OcflFsStore', () => {
  ocflTests.storage(ocfl);
});
