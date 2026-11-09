/**
 * @module ocfl
 */

import { OcflConstants } from './constants.ts';
import { createByName, OcflStorageLayout } from './extension.ts';
import * as extensions from './extensions/index.ts';
import { OcflObject } from './object.ts';
import { type OcflStorage, OcflStorageImpl } from './storage.ts';
import type { OcflStore } from './store.ts';
import type { OcflExtensionConfig, OcflObjectConfig, OcflStorageConfig } from './types.ts';

export { OcflConstants } from './constants.ts';
export { OcflDigest } from './digest.ts';
export type { OcflErrorCode } from './error.ts';
export { ObjectNotFoundError, ObjectNotLoadedError, OcflError } from './error.ts';
export { OcflExtension, OcflStorageLayout } from './extension.ts';
export type { PathDirectStorageLayoutConfig } from './extensions/000N-path-direct-storage-layout.ts';
export type { HashedNTupleStorageLayoutConfig } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
export type { StorageLayout } from './extensions/index.ts';
export type { FileRef, FileStat, OcflObjectFile } from './file.ts';
export type { InventoryFile, OcflObjectInventoryMut, VersionNumber } from './inventory.ts';
export { OcflObjectInventory } from './inventory.ts';
export type { UpdateMode } from './object.ts';
export { OcflObject } from './object.ts';
export { OcflStorage } from './storage.ts';
export type { BinaryOptions, EncodingOptions, ListedFile, ListOptions, WriteFileData } from './store.ts';
export { OcflStore } from './store.ts';
export type { CommitOptions } from './transaction.ts';
export { OcflObjectTransaction } from './transaction.ts';
export type * from './types.ts';
export { ValidationError } from './validation.ts';
export { extensions };

/**
 * Creates a new OCFL core API with a specific backend store.
 * Any backend store implementation module must return the result of this method.
 * @returns Top level OCFL API interface that provides storage and object creation.
 */
export function implementOcfl<SO extends object>(store: { getInstance(options?: SO): OcflStore }, defaultOptions?: SO) {
  return {
    OCFL_VERSIONS: OcflConstants.OCFL_VERSIONS,

    /** Built-in storage layout classes */
    StorageLayout: OcflStorageLayout.layout,

    /**
     * Instantiate a storage layout from extension name or config
     * @param config - Layout name or config
     */
    storageLayout(config: string | OcflExtensionConfig): OcflStorageLayout {
      let name: string | undefined;
      let c: OcflExtensionConfig | undefined;
      if (typeof config === 'string') {
        name = config;
      } else {
        name = config.extensionName;
        c = config;
      }
      return createByName<OcflStorageLayout>(OcflStorageLayout, 'Layout', name, c);
    },

    /**
     * Instantiate an OCFL Object
     */
    object(config: OcflObjectConfig, storeOptions: SO | undefined = defaultOptions): OcflObject {
      return new OcflObject(config, store.getInstance(storeOptions));
    },

    /**
     * Instantiate an OCFL Storage root
     */
    storage(config: OcflStorageConfig, storeOptions: SO | undefined = defaultOptions): OcflStorage {
      return new OcflStorageImpl(config, store.getInstance(storeOptions));
    },

    /**
     * Create a new OCFL Storage
     */
    async createStorage(config: OcflStorageConfig, storeOptions: SO | undefined = defaultOptions): Promise<OcflStorage> {
      return new OcflStorageImpl(config, store.getInstance(storeOptions)).create();
    },

    /**
     * Load an existing OCFL Storage
     */
    async loadStorage(config: OcflStorageConfig, storeOptions: SO | undefined = defaultOptions): Promise<OcflStorage> {
      return new OcflStorageImpl(config, store.getInstance(storeOptions)).load();
    },
  };
}

for (const ext of Object.values(extensions)) {
  ext.register();
}
