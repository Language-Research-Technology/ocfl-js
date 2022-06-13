//@ts-check
const { createObject } = require('./lib/object.js');
const { OcflConstants } = require('ocfl');
// ...require('./lib/storage.js')

module.exports = {
  OcflConstants,
  createObject,
  //createStorage
}
module.exports.default = module.exports;