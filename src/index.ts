import { OcflConstants } from './constants.ts';
import { createLayout } from './extensions/index.ts';
import { OcflStorage } from './storage.ts';
import type { OcflLayoutConfig, OcflLayoutName, OcflStorageConfig, OcflStorageLayout } from './types.ts';

export type { Draft, VersionDetails, WriteContent } from './draft.ts';
export type { OcflErrorCode } from './error.ts';
export { ObjectNotFoundError, ObjectNotLoadedError, OcflError } from './error.ts';
export type { PathDirectStorageLayoutConfig } from './extensions/000N-path-direct-storage-layout.ts';
export type { HashAndIdNTupleStorageLayoutConfig } from './extensions/0003-hash-and-id-n-tuple-storage-layout.ts';
export type { HashedNTupleStorageLayoutConfig } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
export type { FileRef, FileStat, OcflObjectFile } from './file.ts';
export type { InventoryFile, OcflObjectInventory, VersionNumber } from './inventory.ts';
export type { FileRefContent, FileRefDigest, FileRefLogical, LogicalPath, OcflObject as LegacyOcflObject, UpdateMode, UpdateOptions } from './object.ts';
export type { ByteRange, OcflFile } from './ocfl-file.ts';
export type { OcflObject, User, Version } from './ocfl-object.ts';
export type { OcflStorage } from './storage.ts';
export type { StorageRoot } from './storage-root.ts';
export { createStorageRoot, openStorageRoot } from './storage-root.ts';
export type { CommitOptions, ImportSource, OcflObjectTransaction } from './transaction.ts';
export type * from './types.ts';
export type { ValidationErrorCode, ValidationErrorOptions } from './validation.ts';
export { ValidationError } from './validation.ts';

export const OCFL_VERSIONS: readonly ['1.1', '1.0'] = OcflConstants.OCFL_VERSIONS;

/**
 * Instantiate a storage layout from its official extension name or a config object
 * @param config - Official extension name or `{ extensionName, ...params }`
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if anything else is given
 * @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if the layout rejects a parameter
 */
export function storageLayout<N extends OcflLayoutName>(config: N | OcflLayoutConfig<N>): OcflStorageLayout<N> {
  return createLayout(config) as unknown as OcflStorageLayout<N>;
}

/**
 * Instantiate an OCFL Storage root
 */
export function storage(config: OcflStorageConfig): OcflStorage {
  return new OcflStorage(config);
}

/**
 * Create a new OCFL Storage
 */
export async function createStorage(config: OcflStorageConfig): Promise<OcflStorage> {
  return new OcflStorage(config).create();
}

/**
 * Load an existing OCFL Storage
 */
export async function loadStorage(config: OcflStorageConfig): Promise<OcflStorage> {
  return new OcflStorage(config).load();
}

const api: {
  OCFL_VERSIONS: typeof OCFL_VERSIONS;
  createStorage: typeof createStorage;
  loadStorage: typeof loadStorage;
  storage: typeof storage;
  storageLayout: typeof storageLayout;
} = { OCFL_VERSIONS, createStorage, loadStorage, storage, storageLayout };

export default api;
