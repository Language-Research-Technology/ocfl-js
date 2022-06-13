/**
 * @module ocfl
 */

const { OcflConstants, OcflDigest, OcflExtension,
  OcflObject, OcflObjectImpl,
  OcflObjectInventory, OcflObjectTransactionImpl,
  OcflStorage, OcflStorageImpl,
  createObject, createObjectProxy, createTransactionProxy,
  extensions
} = require('./lib/index.js');

module.exports = {
  OcflConstants,
  OcflDigest,
  OcflExtension,
  OcflObject,
  OcflObjectImpl,
  OcflObjectInventory,
  OcflObjectTransactionImpl,
  createObject,
  createObjectProxy,
  createTransactionProxy,
  OcflStorage, OcflStorageImpl,
  extensions
};

extensions.DigestAlgorithm.setup(module.exports);