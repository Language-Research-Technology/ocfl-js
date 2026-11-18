/**
 * Stores and versions digital objects in an Oxford Common File Layout (OCFL) storage root on a local file system.
 *
 * Start with {@link createStorageRoot} for a new storage root or {@link openStorageRoot} for an existing one. A
 * {@link StorageRoot} opens, creates, lists and purges objects. An {@link OcflObject} gives each version's files,
 * and `update` adds a version from a {@link Draft}. A failure the library detects is an {@link OcflError}; test its `code`.
 * File system errors, such as `ENOSPC`, pass through untouched, unless the library knows what one means or it leaves a write
 * needing recovery: then the error has the code for that meaning, such as `CROSS_FILESYSTEM_MOVE`, or `RECOVERY_NEEDED`, with
 * the file system error as its `cause`.
 *
 * @example
 * ```ts
 * import { openStorageRoot } from '@ocfl/ocfl-fs';
 *
 * const root = await openStorageRoot('/srv/ocfl');
 * const object = await root.open('arcp://name,corpus/item/1');
 * await object.update({ message: 'Add transcript', user: { name: 'Alice' } }, async (draft) => {
 *   await draft.write('transcript.txt', transcript);
 * });
 * ```
 *
 * @packageDocumentation
 */

export type { OcflSpecVersion } from './constants.ts';
export type { DigestAlgorithm, FixityAlgorithm } from './digest.ts';
export type {
  CreateOptions,
  Draft,
  DraftFile,
  ImportOptions,
  ImportProgress,
  MergeOptions,
  UpdateOptions,
  User,
  VersionDetails,
  WriteContent,
} from './draft.ts';
export type { OcflErrorCode } from './error.ts';
export { isOcflError, OcflError } from './error.ts';
export type {
  FlatDirectLayoutConfig,
  HashAndIdNTupleLayoutConfig,
  HashedNTupleLayoutConfig,
  Layout,
  LayoutConfig,
  PathDirectLayoutConfig,
} from './layouts/index.ts';
export type { ListedDamagedObjectRoot, ListedObject, ListedOpenedObject, ListOptions } from './list.ts';
export type { OcflFile, ReadOptions, StreamOptions } from './ocfl-file.ts';
export type {
  ExportOptions,
  ExportProgress,
  FixityOptions,
  FixityProblem,
  FixityProgress,
  FixityReport,
  OcflObject,
  Version,
} from './ocfl-object.ts';
export type { CreateStorageRootOptions, Durability, OpenStorageRootOptions, StorageRoot } from './storage-root.ts';
export { createStorageRoot, openStorageRoot } from './storage-root.ts';
export type { UnfinishedWrite } from './unfinished-write.ts';
