"use strict";

const ocfl = require('../index');

describe("OcflStorage class using OcflFsStore", function () {
  require('ocfl-tests/storage.spec')(ocfl);
});

