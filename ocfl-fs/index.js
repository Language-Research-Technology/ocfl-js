//@ts-check
const { OcflFsStore } = require('./lib/store.js');
const { Ocfl } = require('ocfl');
//const { default: ocfl } = require('./index.mjs');

/** @type {import('./lib/store.js').OcflFsStoreConfig} */
let defaultOptions;

module.exports = new Ocfl(OcflFsStore, defaultOptions);
//module.exports.default = module.exports;