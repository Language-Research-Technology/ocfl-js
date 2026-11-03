'use strict';
const ocfl = require('../index');

describe('OcflStorage class using OcflFsStore', () => {
  require('@ocfl/ocfl-tests').storage(ocfl);
});
