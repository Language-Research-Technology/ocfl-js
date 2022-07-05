/**
 * @module ocfl
 */

const { OcflConstants, OcflDigest, OcflExtension, OcflStorageLayout, OcflStore,
  OcflObject, OcflObjectImpl,
  OcflObjectInventory, OcflObjectTransactionImpl,
  OcflStorage, OcflStorageImpl,
  createObjectProxy, createTransactionProxy,
  extensions
} = require('./lib/index.js');

// const { FlatDirectStorageLayout,
//   FlatOmitPrefixStorageLayout,
//   HashAndIdNTupleStorageLayout,
//   HashedNTupleStorageLayout,
//   NTupleOmitPrefixStorageLayout } = extensions;

/** @typedef {import('./lib/object.js').OcflObjectConfig} OcflObjectConfig */
/** @typedef {import('./lib/storage.js').OcflStorageConfig} OcflStorageConfig */

/**
 * @typedef {Object} StorageLayout
 * @property {typeof extensions.FlatDirectStorageLayout} [FlatDirectStorageLayout]
 * @property {typeof extensions.FlatOmitPrefixStorageLayout} [FlatOmitPrefixStorageLayout]
 * @property {typeof extensions.HashAndIdNTupleStorageLayout} [HashAndIdNTupleStorageLayout]
 * @property {typeof extensions.HashedNTupleStorageLayout} [HashedNTupleStorageLayout]
 * @property {typeof extensions.NTupleOmitPrefixStorageLayout} [NTupleOmitPrefixStorageLayout]
 */
/** @typedef {import('./lib/extension.js').OcflExtensionConfig} OcflExtensionConfig */

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
 * Top level OCFL API interface that provides storage and object creation.
 * Any backend store implementation module must return the instance of this class. 
 * @template SO
 */
class Ocfl {
  #store;
  #defaultOptions;

  /**
   * @param {typeof OcflStore} store 
   * @param {SO} defaultOptions
   */
  constructor(store, defaultOptions) {
    this.#store = store;
    this.#defaultOptions = defaultOptions;
  }

  get OCFL_VERSIONS() { return OcflConstants.OCFL_VERSIONS; }

  /** 
   * Built-in storage layout classes
   * @return {StorageLayout} 
   */
  get StorageLayout() { return OcflStorageLayout.layout }

  /**
   * Create a storage layout from extension name or config
   * @param {string|OcflExtensionConfig} config - Layout name or config
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
  }

  /**
   * Create an OCFL Object
   * @param {OcflObjectConfig} config
   * @param {SO} [storeOptions]
   * @return {OcflObject}
   */
  object(config, storeOptions = this.#defaultOptions) {
    return new OcflObjectImpl(config, this.#store.getInstance(storeOptions));
  }

  /**
   * Create an OCFL Storage
   * @param {OcflStorageConfig} config
   * @param {SO} [storeOptions]
   * @return {OcflStorage}
   */
  storage(config, storeOptions = this.#defaultOptions) {
    return new OcflStorageImpl(config, this.#store.getInstance(storeOptions));
  }
}

module.exports = {
  OcflConstants,
  OcflDigest,
  OcflExtension, OcflStorageLayout,
  OcflStore,
  OcflObject,
  OcflObjectImpl,
  OcflObjectInventory,
  OcflObjectTransactionImpl,
  createObjectProxy,
  createTransactionProxy,
  OcflStorage, OcflStorageImpl,
  Ocfl,
  extensions
};

for (let name in extensions) {
  extensions[name].register();
}