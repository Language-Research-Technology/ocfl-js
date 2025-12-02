/**
 * @module ocfl
 */

const { OcflConstants, OcflDigest, OcflExtension, OcflStorageLayout, OcflStore,
  OcflObject, OcflObjectInventory, OcflObjectTransactionImpl,
  OcflStorage, OcflStorageImpl,
  extensions
} = require('./lib/index.js');

/**
 * @typedef {Object} StorageLayout
 * @property {typeof extensions.FlatDirectStorageLayout} FlatDirectStorageLayout
 * @property {typeof extensions.FlatOmitPrefixStorageLayout} FlatOmitPrefixStorageLayout
 * @property {typeof extensions.HashAndIdNTupleStorageLayout} HashAndIdNTupleStorageLayout
 * @property {typeof extensions.HashedNTupleStorageLayout} HashedNTupleStorageLayout
 * @property {typeof extensions.NTupleOmitPrefixStorageLayout} NTupleOmitPrefixStorageLayout
 * @property {typeof extensions.PathDirectStorageLayout} PathDirectStorageLayout
 */

/** @typedef {import('./lib/types').OcflExtensionConfig} OcflExtensionConfig */
/** @typedef {import('./lib/types').OcflObjectConfig} OcflObjectConfig */
/** @typedef {import('./lib/types').OcflStorageConfig} OcflStorageConfig */

/**
 * Create a storage layout from extension name or config
 * @param {string|OcflExtensionConfig} config - Layout name or config
 */
function layout(config) {
  let name, c;
  if (typeof config === 'string') {
    name = config;
  } else {
    name = config.extensionName;
    c = config;
  }
  return OcflStorageLayout.class(name).create(c);
}
let storageLayout = Object.assign(layout, /** @type {StorageLayout} */(OcflStorageLayout.layout))

/**
 * Creates a new OCFL core API with a specific backend store.
 * Any backend store implementation module must return the result of this method. 
 * @param {typeof OcflStore} store 
 * @param {SO} defaultOptions
 * @template SO
 * @returns Top level OCFL API interface that provides storage and object creation.
 */
function implementOcfl(store, defaultOptions) {
  return {
    OCFL_VERSIONS: OcflConstants.OCFL_VERSIONS,

    /** Built-in storage layout classes */
    StorageLayout: OcflStorageLayout.layout,

    /**
     * Instantiate a storage layout from extension name or config
     * @param {string | OcflExtensionConfig} config - Layout name or config
     */
    storageLayout(config) {
      let name, c;
      if (typeof config === 'string') {
        name = config;
      } else {
        name = config.extensionName;
        c = config;
      }
      let cls = OcflStorageLayout.class(name)
      if (!cls) throw new Error(`Layout "${name}" is not supported.`);
      return cls.create(c);
    },

    /**
     * Instantiate an OCFL Object
     * @param {OcflObjectConfig} config
     * @param {SO} [storeOptions]
     */
    object(config, storeOptions = defaultOptions) {
      return new OcflObject(config, store.getInstance(storeOptions));
    },

    /**
     * Instantiate an OCFL Storage root
     * @param {OcflStorageConfig} config
     * @param {SO} [storeOptions]
     * @return {OcflStorage}
     */
    storage(config, storeOptions = defaultOptions) {
      return new OcflStorageImpl(config, store.getInstance(storeOptions));
    },

    /**
     * Create a new OCFL Storage
     * @param {OcflStorageConfig} config
     * @param {SO} [storeOptions]
     * @return {Promise<OcflStorage>}
     */
    async createStorage(config, storeOptions = defaultOptions) {
      return (new OcflStorageImpl(config, store.getInstance(storeOptions))).create();
    },

    /**
     * Load an existing OCFL Storage
     * @param {OcflStorageConfig} config
     * @param {SO} [storeOptions]
     * @return {Promise<OcflStorage>}
     */
    async loadStorage(config, storeOptions = defaultOptions) {
      return (new OcflStorageImpl(config, store.getInstance(storeOptions))).load();
    }
  }
}

module.exports = {
  OcflConstants,
  OcflDigest,
  OcflExtension, OcflStorageLayout,
  OcflStore,
  OcflObject,
  OcflObjectInventory,
  OcflObjectTransactionImpl,
  OcflStorage, OcflStorageImpl,
  implementOcfl,
  extensions
};

for (let name in extensions) {
  extensions[name].register();
}