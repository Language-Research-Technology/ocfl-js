import { OcflConstants } from './constants.ts';
import { createLayout, type OcflStorageLayout } from './extension.ts';
import * as extensions from './extensions/index.ts';
import { OcflObject } from './object.ts';
import { OcflStorage } from './storage.ts';
import type { OcflLayoutConfig, OcflLayoutName, OcflObjectConfig, OcflStorageConfig } from './types.ts';

export type { OcflErrorCode } from './error.ts';
export { ObjectNotFoundError, ObjectNotLoadedError, OcflError } from './error.ts';
export { OcflExtension, OcflStorageLayout } from './extension.ts';
export type { PathDirectStorageLayoutConfig } from './extensions/000N-path-direct-storage-layout.ts';
export type { HashedNTupleStorageLayoutConfig } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
export type { FileRef, FileStat, OcflObjectFile } from './file.ts';
export type { InventoryFile, OcflObjectInventory, VersionNumber } from './inventory.ts';
export type { OcflObject, UpdateMode } from './object.ts';
export type { OcflStorage } from './storage.ts';
export type { CommitOptions, OcflObjectTransaction } from './transaction.ts';
export type * from './types.ts';
export { ValidationError } from './validation.ts';
export { extensions };

export const OCFL_VERSIONS = OcflConstants.OCFL_VERSIONS;

/**
 * Instantiate a storage layout from its official extension name or a config object
 * @param config - Official extension name or `{ extensionName, ...params }`
 * @throws {OcflError} `UNSUPPORTED_LAYOUT` if anything else is given
 */
export function storageLayout(config: OcflLayoutName | OcflLayoutConfig): OcflStorageLayout {
  return createLayout(config);
}

/**
 * Instantiate an OCFL Object
 */
export function object(config: OcflObjectConfig): OcflObject {
  return new OcflObject(config);
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

for (const ext of Object.values(extensions)) {
  ext.register();
}

export default { OCFL_VERSIONS, createStorage, extensions, loadStorage, object, storage, storageLayout };
