// this is an internal index.js to avoid circular dependencies problem
// const { OcflStorage, OcflStorageImpl } = require('./storage.js');
// const { OcflObject,
//   OcflObjectImpl,
//   OcflObjectInventory,
//   OcflObjectTransactionImpl,
//   createObject,
//   createObjectProxy,
//   createTransactionProxy } = require('./object.js');
// const { OcflConstants } = require('./constants.js');
// const { OcflDigest } = require('./digest.js');
// const { OcflExtension } = require('./extension.js');

module.exports = {
  ...require('./constants.js'),
  ...require('./digest.js'),
  ...require('./transaction.js'),
  ...require('./extension.js'),
  ...require('./store.js'),
  ...require('./object.js'),
  ...require('./storage.js'),
  extensions: {
    ...require('./extensions/index.js')
  }
};
