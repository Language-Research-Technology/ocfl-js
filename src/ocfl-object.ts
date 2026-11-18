import fs from 'node:fs';
import nodePath from 'node:path';
import { inspect } from 'node:util';
import { startWrite } from './commit.ts';
import { OcflConstants, type OcflSpecVersion } from './constants.ts';
import { checkedDeclaration, type DeclarationsFound } from './declaration.ts';
import type { DigestAlgorithm } from './digest.ts';
import * as Hashing from './digest.ts';
import { commitDraft, type Draft, type UpdateOptions, type User, type VersionDetails, writeOptions } from './draft.ts';
import { OcflError, objectRootConflict, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { type Inventory, OcflObjectInventory, versionNumbers } from './inventory.ts';
import { objectLocked } from './lock.ts';
import { fileLogicalPath } from './logical-path.ts';
import type { ObjectPlace } from './object-place.ts';
import {
  assertEmptyObjectRoot,
  assertNoMutableHead,
  committedInventory,
  confirmedVersion,
  declaredVersion,
  enclosingObject,
  noCommittedObject,
  objectExists,
  objectOutOfDate,
  objectState,
  withinRootVersion,
} from './object-root.ts';
import { type FileHistory, type OcflFile, VersionFile } from './ocfl-file.ts';
import { specViolation } from './ocfl-rules.ts';
import type { RootInventory } from './root-inventory.ts';
import type { RootSettings, StorageRoot } from './storage-root.ts';
import { functionOption, isNonEmptyString, optionsObject, signalOption, versionArgument } from './utils.ts';

const { INVENTORY_NAME } = OcflConstants;

const FIXITY_CONCURRENCY = 10;

/** One version of an OCFL object. */
interface Version {
  /** Version number, starting at 1. */
  readonly number: number;
  /** When the version was committed. A new `Date` on each read, so compare times with `getTime()`, not `===`. */
  readonly createdAt: Date;
  /** Why the version was made. Absent if whatever wrote the version recorded none. */
  readonly message?: string;
  /** Who made the version. Absent if whatever wrote the version recorded none. */
  readonly user?: User;
  /** The version's files, keyed by logical path. */
  readonly files: ReadonlyMap<string, OcflFile>;

  /**
   * The file at this logical path, as in {@link Version.files}. The path is normalised as draft operations normalise it,
   * so `./notes/a.txt` and `notes//a.txt` give the file at `notes/a.txt`.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the version has no file at `path`, including when `path` is a directory.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   * @example
   * ```ts
   * const metadata = JSON.parse(await object.head.file('ro-crate-metadata.json').text());
   * ```
   */
  file(path: string): OcflFile;

  /**
   * Writes each of the version's files to `dir`, under its logical path, and nothing else. `dir` must be missing or empty: it is made, with its parents, if it is missing.
   * Each file's modification and access times are set to its {@link OcflFile.modifiedAt}. Nothing is flushed to disk.
   * No file is written over, but directories are made by path, so export only to a directory nobody else can write to while the export runs.
   *
   * `onProgress` is called after each file is written. Aborting `signal` stops the export, and no stored file is still open once it rejects.
   * An export that fails or is aborted leaves what it had written, including a file only partly written and the directories it made.
   *
   * @throws `TypeError`, before anything is made, if `dir` is missing, empty or not a string, is the storage root or inside it, `options` is given and isn't an object,
   * has a key other than `signal` and `onProgress`, or `signal` isn't an `AbortSignal` or `onProgress` isn't a function.
   * @throws `signal.reason` if `signal` is aborted, before anything is made if it already is.
   * @throws {@link OcflError} `DIRECTORY_NOT_EMPTY`, before anything is written, if `dir` holds anything.
   * @throws {@link OcflError} `INVALID_OBJECT` if a stored file is missing or isn't a regular file.
   * @throws The error `onProgress` throws; the export stops.
   * @throws The file system error if `dir` or a file in it can't be made or written, or a stored file can't be read.
   * @example
   * ```ts
   * await object.head.exportTo('/srv/exports/item-1', {
   *   signal: AbortSignal.timeout(10 * 60_000),
   *   onProgress: ({ exportedFiles, totalFiles }) => console.log(`${exportedFiles} of ${totalFiles} files written`),
   * });
   * ```
   */
  exportTo(dir: string, options?: ExportOptions): Promise<void>;
}

/** How far {@link Version.exportTo} has got. */
interface ExportProgress {
  /** Files written so far. */
  readonly exportedFiles: number;
  /** Files the export writes in all: every file of the version. */
  readonly totalFiles: number;
}

/** Options for {@link Version.exportTo}. */
interface ExportOptions {
  /** Stops the export when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Called after each file is written. If it throws, the export stops and rejects with that error. */
  readonly onProgress?: ((progress: ExportProgress) => void) | undefined;
}

/** An OCFL object as read at one moment. */
interface OcflObject {
  /** The object's id. */
  readonly id: string;
  /** OCFL version the object conforms to. */
  readonly ocflVersion: OcflSpecVersion;
  /** Algorithm of every {@link OcflFile.digest} in this object. */
  readonly digestAlgorithm: DigestAlgorithm;
  /** Every version, keyed by version number, oldest first. */
  readonly versions: ReadonlyMap<number, Version>;
  /** The latest version. */
  readonly head: Version;

  /**
   * The version with this number, as in {@link OcflObject.versions}; the head is one of them.
   *
   * @throws {@link OcflError} `VERSION_NOT_FOUND` if the object has no version with this number, as for 0, a negative number, a fraction or `NaN`.
   * @throws `TypeError` if `number` is not a number.
   * @example
   * ```ts
   * const transcript = await object.version(2).file('transcript.txt').text();
   * ```
   */
  version(number: number): Version;

  /**
   * Commits one new version made from the draft changed by `change`. If `change` throws, everything is discarded.
   * Returns the object with the new version, or this object if the draft ended the same as the head.
   * The update is committed when the root inventory is replaced: any error but `RECOVERY_NEEDED` means it wasn't committed and can be repeated.
   * This object never changes, whatever the outcome.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's declaration has been damaged, or removed while anything remains in its object root, or now declares a later OCFL version than the storage root's (E081), or the object is now inside another object, since it was opened.
   * @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE` if the object has an active mutable head (extension 0005).
   * @throws {@link OcflError} `VERSION_LIMIT_REACHED` if the object's version names are zero-padded and the next one couldn't start with a zero, as OCFL requires (E011): `v01` to `v09` leaves none.
   * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if a later version has been committed, or the object purged, since this object was opened; open it again and retry.
   * @throws {@link OcflError} `OBJECT_LOCKED` if another writer is updating or purging this object, or died doing so, as an update that threw `RECOVERY_NEEDED` did; `lockedAt` says since when, and is absent if the lock couldn't be read or was released meanwhile. The update never waits for it.
   * @throws {@link OcflError} `CROSS_FILESYSTEM_MOVE` if the workspace is on a different file system from the object.
   * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the storage root's file system doesn't support hard links. Nothing is changed.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if the update failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made couldn't all be removed; `cause` is the failure. The update may have been committed, and the object stays locked, so later updates throw `OBJECT_LOCKED`. Also thrown, before `change` runs, if an earlier update left an unfinished version in the workspace, or the update was refused and its lock couldn't be released. Don't simply repeat the update: recover the object's unfinished write ({@link StorageRoot.unfinishedWrite}), then open the object again to see whether it was committed.
   * @throws `TypeError` if the message or the user's name is missing or empty, the user's address isn't a string, `createdAt` isn't a valid `Date` or is earlier than the head version's date,
   * `options` has a key other than `message`, `user`, `createdAt` and `signal`, its user has one other than `name` and `address`,
   * `options` isn't an object, or its `signal` isn't an `AbortSignal`. Nothing is changed.
   * @throws `Error` if `change` returned while draft operations it started were still running. Await every operation.
   * @throws `options.signal.reason` if the signal is aborted before the commit begins, even if `change` caught the error a draft operation rejected with; the update is discarded, and the object is as it was and isn't locked. A signal already aborted is refused before the lock is taken.
   * @throws Whatever `change` or a draft operation throws; the update is discarded, and the object is as it was and isn't locked.
   * @throws The file system error that stopped the update before the root inventory was replaced; the update is discarded.
   * @example
   * ```ts
   * const updated = await object.update({ message: 'Fix transcript', user: { name: 'Alice' } }, async (draft) => {
   *   await draft.write('transcript.txt', corrected);
   * });
   * ```
   */
  update(options: UpdateOptions, change: (draft: Draft) => Promise<unknown>): Promise<OcflObject>;

  /**
   * Reads every stored file again and compares its digest with the inventory. No problems in the report means the object is intact.
   * Covers the versions this object knows about. Does not look for extra files or check the `fixity` block.
   * Each problem names its stored file by its path from the storage root, and lists the versions and logical paths that read it.
   * Problems are sorted by stored file.
   *
   * `onProgress` is called after each stored file is checked, whether it passed, changed or is missing, and reaches every file before the check resolves.
   * Aborting `signal` stops the check, and no stored file is still open or being read once it rejects.
   *
   * @throws `TypeError`, before anything is read, if `options` is given and isn't an object, has a key other than `signal` and `onProgress`,
   * or `signal` isn't an `AbortSignal` or `onProgress` isn't a function.
   * @throws `signal.reason` if `signal` is aborted, before anything is read if it already is.
   * @throws Whatever `onProgress` throws, which stops the check.
   * @throws The file system error, such as `EACCES` or `EIO`, if a stored file can't be read for any reason but being missing.
   * @example
   * ```ts
   * const { problems, checkedFiles } = await object.checkFixity({
   *   signal: AbortSignal.timeout(10 * 60_000),
   *   onProgress: ({ checkedFiles, totalFiles }) => bar.update(checkedFiles / totalFiles),
   * });
   * console.log(`${checkedFiles} stored files checked, ${problems.length} failed`);
   * ```
   */
  checkFixity(options?: FixityOptions): Promise<FixityReport>;

  /**
   * Whether the object's root inventory is still the file this object was read from: `false` once it has been replaced, changed or removed.
   * Every commit replaces the root inventory, so a commit by any writer makes it `false`; an update that hasn't been committed doesn't.
   * The object returned by {@link StorageRoot.create} or {@link OcflObject.update} is current straight away.
   *
   * A cheap check, not a guarantee: one `stat` of the root inventory, comparing its device, inode, size and modification time with those
   * noted when it was read, and nothing read or validated. A file system can reuse an inode number, so a replaced root inventory of the same
   * size and modification time could still give `true`, though that is unlikely.
   *
   * @throws The file system error if the root inventory can't be checked for any reason but being missing.
   * @example
   * ```ts
   * let object = cache.get(id);
   * if (!object || !(await object.isCurrent())) {
   *   object = await root.open(id);
   *   cache.set(id, object);
   * }
   * ```
   */
  isCurrent(): Promise<boolean>;
}

/** How far {@link OcflObject.checkFixity} has got. */
interface FixityProgress {
  /** Stored files checked so far. */
  readonly checkedFiles: number;
  /** Stored files the check reads in all. */
  readonly totalFiles: number;
}

/** Options for {@link OcflObject.checkFixity}. */
interface FixityOptions {
  /** Stops the check when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Called after each stored file is checked. If it throws, the check stops and rejects with that error. */
  readonly onProgress?: ((progress: FixityProgress) => void) | undefined;
}

/** What {@link OcflObject.checkFixity} found. */
interface FixityReport {
  /** One for each stored file that changed or is missing, sorted by stored file. Empty if the object is intact. */
  readonly problems: readonly FixityProblem[];
  /** Stored files the check read: every content path in the manifest, as {@link FixityProgress.totalFiles} counts them. */
  readonly checkedFiles: number;
}

/** One stored file that failed {@link OcflObject.checkFixity}. */
interface FixityProblem {
  /** `changed` if the content no longer matches its digest, `missing` if there is no regular file at the stored file's path. */
  readonly kind: 'changed' | 'missing';
  /** The stored file's path from the storage root, with `/` between directories, such as `a1b/c2d/item-1/v1/content/audio/1.wav`. Never absolute. */
  readonly storedFile: string;
  /** Every version, by number, and logical path that reads the stored file, by version then path. Empty if none does, as for a second stored file of one digest. */
  readonly affects: readonly { readonly version: number; readonly path: string }[];
  /** The digest the inventory records, in lowercase. */
  readonly expected: string;
  /** The digest found on disk, in lowercase. Absent when the stored file is missing. */
  readonly actual?: string;
}

class OpenedObject implements OcflObject {
  readonly id: string;
  readonly ocflVersion: OcflSpecVersion;
  readonly digestAlgorithm: DigestAlgorithm;
  readonly versions: ReadonlyMap<number, Version>;
  readonly head: Version;
  readonly #place: ObjectPlace;
  readonly #rootSettings: RootSettings;
  readonly #rootInventory: RootInventory;

  /**
   * @param rootSettings - Of the storage root the object was opened or created through
   * @param rootInventory - As `readInventory` returns it, or as a commit returns it
   */
  constructor(place: ObjectPlace, rootSettings: RootSettings, ocflVersion: OcflSpecVersion, rootInventory: RootInventory) {
    const { inventory } = rootInventory;
    this.#place = place;
    this.#rootSettings = rootSettings;
    this.#rootInventory = rootInventory;
    this.id = inventory.id;
    this.ocflVersion = ocflVersion;
    this.digestAlgorithm = inventory.digestAlgorithm;
    this.versions = versionsOf(inventory, place);
    this.head = this.versions.get(inventory.versionNumber.value) as Version;
    Object.freeze(this);
  }

  version(number: number): Version {
    versionArgument(number);
    const version = this.versions.get(number);
    if (!version) {
      throw ocflError('VERSION_NOT_FOUND', `The object <${this.id}> has no version ${number}.`, { objectId: this.id });
    }
    return version;
  }

  async update(options: UpdateOptions, change: (draft: Draft) => Promise<unknown>): Promise<OcflObject> {
    const { details, signal } = writeOptions(options, 'object.update', this.head.createdAt);
    signal?.throwIfAborted();
    const declared = await declaredVersion(this.#place, this.id).catch(async (error: unknown) => {
      if (error instanceof OcflError && error.ocflCode === 'E003' && (await fileSystem.isDirEmpty(this.#place.objectRoot))) {
        throw objectOutOfDate(this.#rootInventory.inventory.id, this.#rootInventory.inventory.head, 'has since been purged');
      }
      throw error;
    });
    withinRootVersion({ objectId: this.id, file: this.#place.objectRoot }, declared, this.#rootSettings.ocflVersion);
    await assertNoMutableHead(
      this.#place.objectRoot,
      this.id,
      `The object <${this.id}> has an active mutable head (extension 0005), which this library doesn't support; it can't be updated until the head is committed or removed.`,
    );
    const inventory = OcflObjectInventory._newVersion(this.#rootInventory.inventory);
    const settings = { ocflVersion: this.ocflVersion, flusher: this.#rootSettings.flusher };
    const committed = await commitDraft(() => startWrite(this.#place, settings, inventory, this.#rootInventory), details, change, signal);
    return committed ? new OpenedObject(this.#place, this.#rootSettings, this.ocflVersion, committed) : this;
  }

  async isCurrent(): Promise<boolean> {
    let identity: fileSystem.FileIdentity;
    try {
      identity = await fileSystem.identityOf(nodePath.join(this.#place.objectRoot, INVENTORY_NAME));
    } catch (error) {
      if (fileSystem.isNothingAtPath(error)) {
        return false;
      }
      throw error;
    }
    return fileSystem.sameIdentity(identity, this.#rootInventory.identity);
  }

  async checkFixity(options?: FixityOptions): Promise<FixityReport> {
    const { signal, onProgress } = progressOptions<FixityOptions>(options, 'object.checkFixity');
    signal?.throwIfAborted();
    const totalFiles = Object.values(this.#rootInventory.inventory.manifest).reduce((count, contentPaths) => count + contentPaths.length, 0);
    const storedFiles = storedFilesOf(this.#rootInventory.inventory);
    const failed: { contentPath: string; expected: string; actual: string | undefined }[] = [];
    let checkedFiles = 0;
    let stopped = false;
    // A worker that throws closes the shared iterator, which stops the others after the file each is reading
    const worker = async () => {
      try {
        for (const [contentPath, expected] of storedFiles) {
          const actual = await digestOfStoredFile(nodePath.join(this.#place.objectRoot, contentPath), this.digestAlgorithm, signal);
          if (actual !== expected) {
            failed.push({ contentPath, expected, actual });
          }
          if (!stopped) {
            onProgress?.({ checkedFiles: ++checkedFiles, totalFiles });
          }
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    // Settled, not raced, so no file is still being read when the check ends
    const outcomes = await Promise.allSettled(Array.from({ length: FIXITY_CONCURRENCY }, worker));
    signal?.throwIfAborted();
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
    if (failed.length === 0) {
      return { problems: [], checkedFiles: totalFiles };
    }
    const affected = affectedFiles(this.#rootInventory.inventory, new Set(failed.map(({ contentPath }) => contentPath)));
    const problems = failed.map(({ contentPath, expected, actual }): FixityProblem => {
      const storedFile = fileSystem.pathFromStorageRoot(this.#place.storageRoot, nodePath.join(this.#place.objectRoot, contentPath));
      const common = { storedFile, affects: affected.get(contentPath) ?? [], expected };
      return actual === undefined ? { kind: 'missing', ...common } : { kind: 'changed', ...common, actual };
    });
    problems.sort((a, b) => Number(a.storedFile > b.storedFile) - Number(a.storedFile < b.storedFile));
    return { problems, checkedFiles: totalFiles };
  }
}

/** Each stored file the inventory's manifest lists, with the normalised digest recorded for it */
function* storedFilesOf(inventory: OcflObjectInventory): Generator<[contentPath: string, digest: string]> {
  for (const [digest, contentPaths] of Object.entries(inventory.manifest)) {
    for (const contentPath of contentPaths) {
      yield [contentPath, Hashing.normaliseDigest(digest)];
    }
  }
}

/**
 * Each version and logical path that reads one of the stored files at `contentPaths`, by version then path, keyed by that content path.
 * A logical path reads the first content path the manifest gives its digest, so a later one for the same digest is read by none.
 */
function affectedFiles(inventory: OcflObjectInventory, contentPaths: ReadonlySet<string>): Map<string, FixityProblem['affects']> {
  const affected = new Map<string, { version: number; path: string }[]>();
  for (const [version, name] of versionNumbers(inventory)) {
    const files = [...inventory.files(name)].filter(({ contentPath }) => contentPaths.has(contentPath));
    files.sort((a, b) => Number(a.logicalPath > b.logicalPath) - Number(a.logicalPath < b.logicalPath));
    for (const { logicalPath, contentPath } of files) {
      let entries = affected.get(contentPath);
      if (!entries) {
        entries = [];
        affected.set(contentPath, entries);
      }
      entries.push({ version, path: logicalPath });
    }
  }
  return affected;
}

/** The options of a read that takes a `signal` and an `onProgress` callback, as `call` names it */
function progressOptions<T extends FixityOptions | ExportOptions>(options: unknown, call: string): T {
  const checked = optionsObject(options, call, ['signal', 'onProgress'], '{ signal: AbortSignal.timeout(60_000) }');
  signalOption(checked.signal);
  functionOption('onProgress', checked.onProgress);
  return checked as T;
}

/** The digest of the stored file at `file`, or `undefined` if it is missing or isn't a regular file */
async function digestOfStoredFile(file: string, digestAlgorithm: DigestAlgorithm, signal: AbortSignal | undefined): Promise<string | undefined> {
  const opened = await fileSystem.openRegularFile(file);
  if ('absent' in opened) {
    return undefined;
  }
  return fileSystem.withReadStream(opened.handle, signal, (bytes) => Hashing.digest(digestAlgorithm, bytes));
}

/** Walks back from a file's own version, through the inventory's index of each version's digests, for as long as the file is unchanged */
class ObjectHistory implements FileHistory {
  readonly #inventory: OcflObjectInventory;
  readonly #versions: ReadonlyMap<number, Version>;
  readonly #order: readonly [number: number, name: string][];

  constructor(inventory: OcflObjectInventory, versions: ReadonlyMap<number, Version>) {
    this.#inventory = inventory;
    this.#versions = versions;
    this.#order = versionNumbers(inventory);
  }

  createdIn(path: string, version: number): Version {
    return this.#earliest(path, version, (found) => found !== undefined);
  }

  modifiedIn(path: string, digest: string, version: number): Version {
    return this.#earliest(path, version, (found) => found === digest);
  }

  /** The first of the versions up to `version` whose digests at `path` all pass `unbroken` */
  #earliest(path: string, version: number, unbroken: (found: string | undefined) => boolean): Version {
    let at = this.#order.findIndex(([number]) => number === version);
    for (; at > 0; at--) {
      const [, name] = this.#order[at - 1] as [number, string];
      if (!unbroken(this.#inventory.getDigest(path, name))) {
        break;
      }
    }
    const [number] = this.#order[at] as [number, string];
    return this.#versions.get(number) as Version;
  }
}

class ObjectVersion implements Version {
  readonly number: number;
  declare readonly createdAt: Date;
  declare readonly message?: string;
  declare readonly user?: User;
  readonly #inventory: OcflObjectInventory;
  readonly #name: string;
  readonly #place: ObjectPlace;
  readonly #history: ObjectHistory;
  #files: ReadonlyMap<string, OcflFile> | undefined;

  constructor(inventory: OcflObjectInventory, number: number, name: string, place: ObjectPlace, history: ObjectHistory) {
    const { created, message, user } = inventory.versions[name] as Inventory['versions'][string];
    this.number = number;
    const time = Date.parse(created);
    // Own and enumerable so JSON and spread keep it; a copy per read so no holder can change it
    Object.defineProperty(this, 'createdAt', { enumerable: true, get: () => new Date(time) });
    if (typeof message === 'string') {
      this.message = message;
    }
    if (user) {
      this.user = Object.freeze({ name: user.name, ...(user.address !== undefined && { address: user.address }) });
    }
    this.#inventory = inventory;
    this.#name = name;
    this.#place = place;
    this.#history = history;
    Object.freeze(this);
  }

  file(path: string): OcflFile {
    const objectId = this.#inventory.id;
    const logicalPath = fileLogicalPath(path, objectId);
    const file = this.files.get(logicalPath);
    if (!file) {
      throw ocflError('FILE_NOT_FOUND', `Version ${this.number} of the object <${objectId}> has no file at logical path "${path}".`, {
        objectId,
        logicalPath,
      });
    }
    return file;
  }

  // Listed on first use: an object can have many versions of many files, and most readers want only the head
  get files(): ReadonlyMap<string, OcflFile> {
    if (!this.#files) {
      const files = new Map<string, OcflFile>();
      for (const { logicalPath: path, digest, contentPath } of this.#inventory.files(this.#name)) {
        files.set(
          path,
          new VersionFile({
            path,
            digest,
            version: this.number,
            objectId: this.#inventory.id,
            objectRoot: this.#place.objectRoot,
            contentPath,
            history: this.#history,
          }),
        );
      }
      this.#files = files;
    }
    return this.#files;
  }

  async exportTo(dir: string, options?: ExportOptions): Promise<void> {
    if (!isNonEmptyString(dir)) {
      throw new TypeError(`The directory to export to is required, not ${inspect(dir)}.`);
    }
    const { signal, onProgress } = progressOptions<ExportOptions>(options, 'version.exportTo');
    signal?.throwIfAborted();
    const target = nodePath.resolve(dir);
    if (fileSystem.relativeWithin(this.#place.storageRoot, target) !== undefined) {
      throw new TypeError(`Cannot export to ${target}, which is inside the storage root ${this.#place.storageRoot}.`);
    }
    await fs.promises.mkdir(target, { recursive: true });
    if (!(await fileSystem.isDirEmpty(target))) {
      throw ocflError('DIRECTORY_NOT_EMPTY', `Cannot export version ${this.number} of <${this.#inventory.id}> to ${target}, which is not empty.`);
    }
    const totalFiles = this.files.size;
    let exportedFiles = 0;
    for (const [logicalPath, file] of this.files) {
      signal?.throwIfAborted();
      const relative = fileSystem.relativeWithin(target, logicalPath);
      // Opening refuses a logical path that leaves the object, so this guards only against that check changing
      /* node:coverage disable */
      if (!relative) {
        throw specViolation('E052', this.#place.objectRoot, `logical path "${logicalPath}" in v${this.number} leaves the object`);
      }
      /* node:coverage enable */
      await fileSystem.writeFileFrom(nodePath.join(target, relative), () => file.stream(), file.modifiedAt, signal);
      onProgress?.({ exportedFiles: ++exportedFiles, totalFiles });
    }
  }
}

function versionsOf(inventory: OcflObjectInventory, place: ObjectPlace): ReadonlyMap<number, Version> {
  const versions = new Map<number, Version>();
  const history = new ObjectHistory(inventory, versions);
  for (const [number, name] of versionNumbers(inventory)) {
    versions.set(number, new ObjectVersion(inventory, number, name, place, history));
  }
  return versions;
}

/**
 * Opens the object `id` that the layout of the storage root, with the settings `rootSettings`, places at `place`.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if its object root has no inventory, and either nothing in it or a lock held: a create that isn't committed
 * @throws {@link OcflError} `INVALID_OBJECT` if it has a declaration and no inventory and isn't locked, is inside another object, is of a later OCFL version than the storage root, or its inventory can't be used
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it holds an object with another id, or, with no declaration, inventory or lock, holds anything else, is a file or is below one
 */
async function openObject(place: ObjectPlace, id: string, rootSettings: RootSettings): Promise<OcflObject> {
  const root = await committedInventory(place, id);
  if (!root) {
    throw await noCommittedObject(place, id);
  }
  const ocflVersion = withinRootVersion({ objectId: id, file: place.objectRoot }, await confirmedVersion(place, root.inventory, id), rootSettings.ocflVersion);
  return new OpenedObject(place, rootSettings, ocflVersion, root);
}

/**
 * Opens the object at `place`, a directory found with the object declaration `declared` and inside no other object, in a storage root with the settings `rootSettings`.
 * @param declared - As `findDeclaredVersion` returns it for a declaration that exists
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has gone
 * @throws {@link OcflError} `INVALID_OBJECT` if it has more than one declaration (`E003`), or its declaration is invalid or of a later OCFL version than the storage root, or its inventory is missing or can't be used
 */
async function openDeclaredObject(place: ObjectPlace, declared: DeclarationsFound, rootSettings: RootSettings): Promise<OcflObject | undefined> {
  const { objectRoot } = place;
  const ocflVersion = checkedDeclaration(objectRoot, declared);
  const root = await committedInventory(place);
  return (
    root &&
    new OpenedObject(place, rootSettings, withinRootVersion({ objectId: root.inventory.id, file: objectRoot }, ocflVersion, rootSettings.ocflVersion), root)
  );
}

/**
 * Creates the object `id` at `place`, where the storage root's layout places it, with the draft `build` leaves as its first version.
 * @param details - As {@link writeOptions} returns them
 * @throws {@link OcflError} `OBJECT_EXISTS` if its object root has an object declaration or an inventory
 * @throws {@link OcflError} `OBJECT_LOCKED` if it has a declaration, no inventory and a lock held: a create that isn't committed
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it holds anything else, is below a file, or is inside another object
 */
async function createObject(
  place: ObjectPlace,
  id: string,
  rootSettings: RootSettings,
  details: VersionDetails,
  build: (draft: Draft) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<OcflObject> {
  const { objectRoot } = place;
  const state = await objectState(place);
  if (state === 'committed') {
    throw objectExists(id);
  }
  if (state === 'creating') {
    throw await objectLocked(place.workspace, id);
  }
  await assertEmptyObjectRoot(objectRoot, id);
  const outer = await enclosingObject(place);
  if (outer !== undefined) {
    throw objectRootConflict(objectRoot, id, `is inside the object at ${outer}`);
  }
  const { ocflVersion } = rootSettings;
  const inventory = OcflObjectInventory._newVersion({
    id,
    digestAlgorithm: 'sha512',
    type: `https://ocfl.io/${ocflVersion}/spec/#inventory`,
    contentDirectory: 'content',
  });
  const committed = await commitDraft(() => startWrite(place, rootSettings, inventory), details, build, signal);
  // A first version always differs from no version, so it is always committed
  /* node:coverage disable */
  if (!committed) {
    throw new Error(`No first version of <${id}> was committed.`);
  }
  /* node:coverage enable */
  return new OpenedObject(place, rootSettings, ocflVersion, committed);
}

export {
  createObject,
  type ExportOptions,
  type ExportProgress,
  type FixityOptions,
  type FixityProblem,
  type FixityProgress,
  type FixityReport,
  type OcflObject,
  openDeclaredObject,
  openObject,
  type Version,
};
