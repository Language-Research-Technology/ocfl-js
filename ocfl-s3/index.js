const { OcflS3Store } = require('./lib/store.js');
const { Ocfl } = require('@ocfl/ocfl');

/** @type {import('./lib/store.js').OcflS3StoreConfig} */
let defaultOptions;

module.exports = new Ocfl(OcflS3Store, defaultOptions);
