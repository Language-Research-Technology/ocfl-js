//@ts-check
const { OcflFsStore } = require('./lib/store.js');
const { implementOcfl } = require('@ocfl/ocfl');
//const { default: ocfl } = require('./index.mjs');

/** @type {import('./lib/store.js').OcflFsStoreConfig} */
let defaultOptions;

const ocfl = implementOcfl(OcflFsStore, defaultOptions);
const { OCFL_VERSIONS, StorageLayout, createStorage, loadStorage, object, storage, storageLayout } = ocfl;
module.exports = {
  OCFL_VERSIONS, StorageLayout, createStorage, loadStorage, object, storage, storageLayout 
};
//module.exports.default = module.exports;