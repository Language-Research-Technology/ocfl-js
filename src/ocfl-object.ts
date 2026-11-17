import nodePath from 'node:path';
import { type DeclarationsFound, OcflConstants, type OcflVersion } from './constants.ts';
import type { DigestAlgorithm } from './digest.ts';
import * as Hashing from './digest.ts';
import { checkedDetails, commitDraft, type Draft, type UpdateOptions, type User, type VersionDetails } from './draft.ts';
import { OcflError, objectRootConflict, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { type Inventory, OcflObjectInventory, versionNumbers } from './inventory.ts';
import { updateInProgress } from './lock.ts';
import {
  assertNoMutableHead,
  checkedDeclaration,
  committedInventory,
  confirmedVersion,
  declaredVersion,
  enclosingObject,
  noCommittedObject,
  objectState,
  strayContents,
  withinRootVersion,
} from './object-on-disk.ts';
import { type FileHistory, type OcflFile, StoredFile } from './ocfl-file.ts';
import type { StorageRoot } from './storage-root.ts';
import { objectWorkspace } from './workspace.ts';

const { INVENTORY_NAME } = OcflConstants;

const FIXITY_CONCURRENCY = 10;

/** One version of an OCFL object. */
interface Version {
  /** Version number, starting at 1. */
  readonly number: number;
  /** When the version was committed. */
  readonly createdAt: Date;
  /** Why the version was made. Absent if whatever wrote the version recorded none. */
  readonly message?: string;
  /** Who made the version. Absent if whatever wrote the version recorded none. */
  readonly user?: User;
  /** The version's files, keyed by logical path. */
  readonly files: ReadonlyMap<string, OcflFile>;
}

/** An OCFL object as read at one moment. */
interface OcflObject {
  /** The object's identifier. */
  readonly id: string;
  /** OCFL version the object conforms to. */
  readonly ocflVersion: OcflVersion;
  /** Algorithm of every {@link OcflFile.digest} in this object. */
  readonly digestAlgorithm: DigestAlgorithm;
  /** Every version, keyed by version number, oldest first. */
  readonly versions: ReadonlyMap<number, Version>;
  /** The latest version. */
  readonly head: Version;

  /**
   * Commits one new version made from the draft changed by `change`. If `change` throws, everything is discarded.
   * Returns the object with the new version, or this object if the draft ended the same as the head.
   * The update is committed when the root inventory is replaced: any error but `RECOVERY_NEEDED` means it wasn't committed and can be repeated.
   * This object never changes, whatever the outcome.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's declaration has been damaged, or removed while anything remains in its object root, or now declares a later OCFL version than the storage root's (E081), or the object is now inside another object, since it was opened.
   * @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE` if the object has an active mutable head (extension 0005).
   * @throws {@link OcflError} `VERSION_LIMIT_REACHED` if the object's version names are zero-padded and the next one couldn't start with a zero, as OCFL requires (E011): `v01` to `v09` leaves none.
   * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if a later version has been committed, or the object removed, since this object was opened; open it again and retry.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if another writer is updating or removing this object, or died doing so; `lockedAt` says since when, and is absent if the lock couldn't be read or was released meanwhile. The update never waits for it.
   * @throws {@link OcflError} `CROSS_FILESYSTEM_MOVE` if the workspace is on a different file system from the object.
   * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the storage root's file system doesn't support hard links. Nothing is changed.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if the update failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made couldn't all be removed; `cause` is the failure. The update may have been committed, and the object stays locked, so later updates throw `UPDATE_IN_PROGRESS`. Also thrown, before `change` runs, if an earlier update left an unfinished version in the workspace, or the update was refused and its lock couldn't be released. Don't simply repeat the update: recover the object's unfinished write ({@link StorageRoot.unfinishedWrite}), then open the object again to see whether it was committed.
   * @throws `TypeError` if the message or the user's name is missing or empty, the user's address isn't a string, or `createdAt` isn't a valid `Date` or is earlier than the head version's date. Nothing is changed.
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
  update(details: VersionDetails, change: (draft: Draft) => Promise<unknown>, options?: UpdateOptions): Promise<OcflObject>;

  /**
   * Reads every stored file again and compares its digest with the inventory. An empty list means the object is intact.
   * Covers the versions this object knows about. Does not look for extra files or check the `fixity` block.
   * Each problem names its stored file by its path from the storage root, and lists the versions and logical paths that read it.
   * Problems are sorted by stored file.
   *
   * `onProgress` is called after each stored file is checked, whether it passed, changed or is missing, and reaches every file before the check resolves.
   * Aborting `signal` stops the check, and no stored file is still open or being read once it rejects.
   *
   * @throws `signal.reason` if `signal` is aborted, before anything is read if it already is.
   * @throws Whatever `onProgress` throws, which stops the check.
   * @throws The file system error, such as `EACCES` or `EIO`, if a stored file can't be read for any reason but being missing.
   * @example
   * ```ts
   * const problems = await object.checkFixity({
   *   signal: AbortSignal.timeout(10 * 60_000),
   *   onProgress: ({ checkedFiles, totalFiles }) => bar.update(checkedFiles / totalFiles),
   * });
   * ```
   */
  checkFixity(options?: FixityOptions): Promise<readonly FixityProblem[]>;

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

/** One stored file that failed {@link OcflObject.checkFixity}. */
interface FixityProblem {
  /** `changed` if the content no longer matches its digest, `missing` if there is no regular file at the stored file's path. */
  readonly problem: 'changed' | 'missing';
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
  readonly ocflVersion: OcflVersion;
  readonly digestAlgorithm: DigestAlgorithm;
  readonly versions: ReadonlyMap<number, Version>;
  readonly head: Version;
  readonly #inventory: OcflObjectInventory;
  readonly #root: string;
  readonly #storageRoot: string;
  readonly #rootVersion: OcflVersion;

  /**
   * @param rootVersion - The storage root's OCFL version
   * @param inventory - As {@link readInventory} returns it, or as a commit returns it
   */
  constructor(storageRoot: string, rootVersion: OcflVersion, root: string, ocflVersion: OcflVersion, inventory: OcflObjectInventory) {
    this.#storageRoot = storageRoot;
    this.#rootVersion = rootVersion;
    this.#root = root;
    this.#inventory = inventory;
    this.id = inventory.id;
    this.ocflVersion = ocflVersion;
    this.digestAlgorithm = inventory.digestAlgorithm;
    this.versions = versionsOf(inventory, root);
    this.head = this.versions.get(inventory.versionNumber.value) as Version;
    Object.freeze(this);
  }

  async update(details: VersionDetails, change: (draft: Draft) => Promise<unknown>, options: UpdateOptions = {}): Promise<OcflObject> {
    const checked = checkedDetails(details, this.head.createdAt);
    options.signal?.throwIfAborted();
    const declared = await declaredVersion(this.#storageRoot, this.#root).catch(async (error: unknown) => {
      if (error instanceof OcflError && error.ocflCode === 'E003' && (await fileSystem.isDirEmpty(this.#root))) {
        throw ocflError(
          'OBJECT_OUT_OF_DATE',
          `The object at ${this.#root} was opened at ${this.#inventory.head}, and has since been removed. Open it again and retry.`,
        );
      }
      throw error;
    });
    withinRootVersion(this.#root, declared, this.#rootVersion);
    await assertNoMutableHead(
      this.#root,
      `The object <${this.id}> has an active mutable head (extension 0005), which this library doesn't support; it can't be updated until the head is committed or removed.`,
    );
    const inventory = OcflObjectInventory._newVersion(this.#inventory);
    const place = { storageRoot: this.#storageRoot, objectRoot: this.#root, ocflVersion: this.ocflVersion };
    const committed = await commitDraft(place, inventory, checked, change, options.signal);
    return committed ? new OpenedObject(this.#storageRoot, this.#rootVersion, this.#root, this.ocflVersion, committed) : this;
  }

  async isCurrent(): Promise<boolean> {
    let identity: fileSystem.FileIdentity;
    try {
      identity = await fileSystem.identityOf(nodePath.join(this.#root, INVENTORY_NAME));
    } catch (error) {
      if (fileSystem.isNothingAtPath(error)) {
        return false;
      }
      throw error;
    }
    return fileSystem.sameIdentity(identity, this.#inventory._identity as fileSystem.FileIdentity);
  }

  async checkFixity(options: FixityOptions = {}): Promise<readonly FixityProblem[]> {
    const { signal, onProgress } = options;
    signal?.throwIfAborted();
    const totalFiles = Object.values(this.#inventory.manifest).reduce((count, contentPaths) => count + contentPaths.length, 0);
    const storedFiles = storedFilesOf(this.#inventory);
    const failed: { contentPath: string; expected: string; actual: string | undefined }[] = [];
    let checkedFiles = 0;
    let stopped = false;
    // A worker that throws closes the shared iterator, which stops the others after the file each is reading
    const worker = async () => {
      try {
        for (const [contentPath, expected] of storedFiles) {
          const actual = await digestOfStoredFile(nodePath.join(this.#root, contentPath), this.digestAlgorithm, signal);
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
      return [];
    }
    const affected = affectedFiles(this.#inventory, new Set(failed.map(({ contentPath }) => contentPath)));
    const problems = failed.map(({ contentPath, expected, actual }): FixityProblem => {
      const storedFile = fileSystem.pathFromStorageRoot(this.#storageRoot, nodePath.join(this.#root, contentPath));
      const common = { storedFile, affects: affected.get(contentPath) ?? [], expected };
      return actual === undefined ? { problem: 'missing', ...common } : { problem: 'changed', ...common, actual };
    });
    return problems.sort((a, b) => Number(a.storedFile > b.storedFile) - Number(a.storedFile < b.storedFile));
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
  readonly createdAt: Date;
  declare readonly message?: string;
  declare readonly user?: User;
  readonly #inventory: OcflObjectInventory;
  readonly #name: string;
  readonly #objectRoot: string;
  readonly #history: ObjectHistory;
  #files: ReadonlyMap<string, OcflFile> | undefined;

  constructor(inventory: OcflObjectInventory, number: number, name: string, objectRoot: string, history: ObjectHistory) {
    const { created, message, user } = inventory.versions[name] as Inventory['versions'][string];
    this.number = number;
    this.createdAt = new Date(created);
    if (typeof message === 'string') {
      this.message = message;
    }
    if (user) {
      this.user = Object.freeze({ name: user.name, ...(user.address !== undefined && { address: user.address }) });
    }
    this.#inventory = inventory;
    this.#name = name;
    this.#objectRoot = objectRoot;
    this.#history = history;
    Object.freeze(this);
  }

  // Listed on first use: an object can have many versions of many files, and most readers want only the head
  get files(): ReadonlyMap<string, OcflFile> {
    if (!this.#files) {
      const files = new Map<string, OcflFile>();
      for (const { logicalPath: path, digest, contentPath } of this.#inventory.files(this.#name)) {
        files.set(path, new StoredFile({ path, digest, version: this.number, objectRoot: this.#objectRoot, contentPath, history: this.#history }));
      }
      this.#files = files;
    }
    return this.#files;
  }
}

function versionsOf(inventory: OcflObjectInventory, objectRoot: string): ReadonlyMap<number, Version> {
  const versions = new Map<number, Version>();
  const history = new ObjectHistory(inventory, versions);
  for (const [number, name] of versionNumbers(inventory)) {
    versions.set(number, new ObjectVersion(inventory, number, name, objectRoot, history));
  }
  return versions;
}

/**
 * Opens the object `id` that the layout of the storage root, of OCFL version `rootVersion`, places at `objectRoot`.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if `objectRoot` has no inventory, and either nothing in it or a lock held: a create that isn't committed
 * @throws {@link OcflError} `INVALID_OBJECT` if it has a declaration and no inventory and isn't locked, is inside another object, is of a later OCFL version than the storage root, or its inventory can't be used
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it holds an object with another id, or, with no declaration, inventory or lock, holds anything else, is a file or is below one
 */
async function openObject(storageRoot: string, objectRoot: string, id: string, rootVersion: OcflVersion): Promise<OcflObject> {
  const inventory = await committedInventory(storageRoot, objectRoot);
  if (!inventory) {
    throw await noCommittedObject(storageRoot, objectRoot, id);
  }
  const ocflVersion = withinRootVersion(objectRoot, await confirmedVersion(storageRoot, objectRoot, inventory, id), rootVersion);
  return new OpenedObject(storageRoot, rootVersion, objectRoot, ocflVersion, inventory);
}

/**
 * Opens the object at `objectRoot`, a directory found with the object declaration `declared` and inside no other object, in a storage root of OCFL version `rootVersion`.
 * @param declared - As `findNamasteVersion` returns it for a declaration that exists
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has gone
 * @throws {@link OcflError} `INVALID_OBJECT` if it has more than one declaration (`E003`), or its declaration is invalid or of a later OCFL version than the storage root, or its inventory is missing or can't be used
 */
async function openDeclaredObject(
  storageRoot: string,
  objectRoot: string,
  declared: DeclarationsFound,
  rootVersion: OcflVersion,
): Promise<OcflObject | undefined> {
  const ocflVersion = checkedDeclaration(objectRoot, declared);
  const inventory = await committedInventory(storageRoot, objectRoot);
  return inventory && new OpenedObject(storageRoot, rootVersion, objectRoot, withinRootVersion(objectRoot, ocflVersion, rootVersion), inventory);
}

/**
 * Creates the object `id` at `objectRoot`, where the storage root's layout places it, with the draft `build` leaves as its first version.
 * @param details - As {@link checkedDetails} returns them
 * @throws {@link OcflError} `OBJECT_EXISTS` if `objectRoot` has an object declaration or an inventory
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if it has a declaration, no inventory and a lock held: a create that isn't committed
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it holds anything else, is below a file, or is inside another object
 */
async function createObject(
  storageRoot: string,
  objectRoot: string,
  id: string,
  ocflVersion: OcflVersion,
  details: VersionDetails,
  build: (draft: Draft) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<OcflObject> {
  const state = await objectState(storageRoot, objectRoot);
  if (state === 'committed') {
    throw ocflError('OBJECT_EXISTS', `There is already an object at ${objectRoot}, where the storage root ${storageRoot} places <${id}>.`);
  }
  if (state === 'creating') {
    throw await updateInProgress(objectWorkspace(storageRoot, objectRoot));
  }
  const contents = await fileSystem.dirContents(objectRoot);
  if (contents !== 'empty') {
    throw strayContents(objectRoot, id, contents);
  }
  const outer = await enclosingObject(storageRoot, objectRoot);
  if (outer !== undefined) {
    throw objectRootConflict(objectRoot, id, `is inside the object at ${outer}`);
  }
  const inventory = OcflObjectInventory._newVersion({
    id,
    digestAlgorithm: 'sha512',
    type: `https://ocfl.io/${ocflVersion}/spec/#inventory`,
    contentDirectory: 'content',
  });
  const committed = await commitDraft({ storageRoot, objectRoot, ocflVersion }, inventory, details, build, signal);
  // A first version always differs from no version, so it is always committed
  /* node:coverage disable */
  if (!committed) {
    throw new Error(`No first version of <${id}> was committed.`);
  }
  /* node:coverage enable */
  return new OpenedObject(storageRoot, ocflVersion, objectRoot, ocflVersion, committed);
}

export { createObject, type FixityOptions, type FixityProblem, type FixityProgress, type OcflObject, openDeclaredObject, openObject, type Version };
