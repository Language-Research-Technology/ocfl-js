import tests from '@ocfl/ocfl-tests'; // eslint-disable-line import/no-extraneous-dependencies

import { storeConfig, helpers } from './setup';
import ocfl from '../src/index';

describe('OcflObject class using OcflFsStore', () => {
  tests.object(ocfl, storeConfig, helpers);
});
