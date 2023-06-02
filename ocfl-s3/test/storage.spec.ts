import tests from '@ocfl/ocfl-tests'; // eslint-disable-line import/no-extraneous-dependencies

import ocfl from '../src/index';

import { storeConfig, helpers } from './setup';

describe('OcflStorage class using OcflFsStore', () => {
  tests.storage(ocfl, storeConfig, helpers);
});
