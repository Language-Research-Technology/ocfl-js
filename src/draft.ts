import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { findNamasteVersion, OcflConstants, type OcflVersion } from './constants.ts';
import * as Hashing from './digest.ts';
import { ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { ContentRelease, DeletePlan, OcflObjectInventory, RelistPlan } from './inventory.ts';
import { rootInventoryPaths, sidecarContent } from './inventory-files.ts';
import { lockKept, releaseLock, takeLock } from './lock.ts';
import { checkLogicalPath, fileLogicalPath, invalidLogicalPath, normaliseLogicalPath } from './logical-path.ts';
import { createError } from './ocfl-rules.ts';
import { createLimiter, isNonEmptyString, parseJsonObject } from './utils.ts';
import { objectWorkspace } from './workspace.ts';

const { INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

/** The person or system responsible for a version. */
interface User {
  /** Display name. */
  readonly name: string;
  /** A URI for the user, such as `mailto:` or an ORCID. */
  readonly address?: string;
}

/** What a new version records about why and by whom it was made. */
interface VersionDetails {
  /** Why the version is being made. */
  readonly message: string;
  /** Who is making it. */
  readonly user: User;
  /**
   * When the version is dated, such as its original date in a migration. Defaults to now. Can't be earlier than the head version's date.
   *
   * @example
   * ```ts
   * await root.create(id, { message, user, createdAt: new Date('2019-03-01T00:00:00Z') }, build);
   * ```
   */
  readonly createdAt?: Date;
}

/** Options for `StorageRoot.create` and `OcflObject.update`. */
interface UpdateOptions {
  /**
   * Cancels the create or update when aborted: draft operations started after that reject with its reason, and the draft is discarded once the callback settles.
   * It is checked one last time just before the commit begins, and ignored after that.
   *
   * @example
   * ```ts
   * await object.update(details, (draft) => draft.import(dir), { signal: request.signal });
   * ```
   */
  readonly signal?: AbortSignal | undefined;
}

/** Content for {@link Draft.write}: text (stored as UTF-8), bytes, or a stream of either, such as a Node or web stream. */
type WriteContent = string | Uint8Array | AsyncIterable<string | Uint8Array>;

/** Options for {@link Draft.copy} and {@link Draft.rename}. */
interface MergeOptions {
  /** Whether a directory goes file by file into a `target` that already has files. Defaults to `false`. */
  readonly merge?: boolean | undefined;
}

/**
 * The changes being assembled during an update, which become one new version or are discarded.
 *
 * It starts with the files of the head version (none, for a new object). Operations take effect in call order,
 * even when started together. Every logical path is normalised first (`./raw//1.wav` is `raw/1.wav`).
 * Once the update's `signal` is aborted, every operation started after that rejects with its reason, and an import stops between files.
 */
interface Draft {
  /**
   * Puts one file at `path`, replacing a file already there.
   *
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   * @throws {@link OcflError} `FILE_EXISTS` if `path` is a directory, or lies below a file.
   * @throws `TypeError` if `content` is not a {@link WriteContent}.
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.write('ro-crate-metadata.json', JSON.stringify(metadata));
   * });
   * ```
   */
  write(path: string, content: WriteContent): Promise<void>;

  /**
   * Copies a file or directory from disk into the draft, at `target` or at the top. Files already there are replaced; the rest stay.
   *
   * Without a `target`, a directory's contents go at the top and a file keeps its own name there.
   * Everything below a directory is copied, including hidden files. If a file fails, the first failure is thrown and the draft is left as it was.
   *
   * @throws {@link OcflError} `UNSUPPORTED_FILE_TYPE` if `source` is, or contains, anything but regular files and directories, such as a symlink.
   * @throws {@link OcflError} `SOURCE_CHANGED` if a file changed while it was being read.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `target` is empty or leaves the object.
   * @throws {@link OcflError} `FILE_EXISTS` if a path would become both a file and a directory.
   * @throws `Error` if the update this draft belongs to has finished.
   * @throws The file system error if `source`, or something below it, is missing or can't be read.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.import('/data/incoming/item-1', 'raw');
   * });
   * ```
   */
  import(source: string, target?: string): Promise<void>;

  /**
   * Copies a file, or every file below a directory, to `target` within the draft.
   * With `merge`, a directory goes file by file into a `target` that has files: files at the same path are replaced and the rest stay.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` is not in the draft.
   * @throws {@link OcflError} `FILE_EXISTS` if `source` is a directory and `target` already has files, unless `merge` is set; or if a file would go where a directory is, or below a file, as the draft stands before the operation.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`.
   * @throws `TypeError` if `options` is given and is not an object, or its `merge` is given and is not a boolean.
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.copy('audio/1.wav', 'archive/1.wav');
   * });
   * ```
   */
  copy(source: string, target: string, options?: MergeOptions): Promise<void>;

  /**
   * Moves a file, or every file below a directory, to `target` within the draft.
   * With `merge`, a directory goes file by file into a `target` that has files: files at the same path are replaced and the rest stay.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` is not in the draft.
   * @throws {@link OcflError} `FILE_EXISTS` if `source` is a directory and `target` already has files, unless `merge` is set; or if a file would go where a directory is, or below a file, as the draft stands before the operation.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`.
   * @throws `TypeError` if `options` is given and is not an object, or its `merge` is given and is not a boolean.
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.rename('scans', 'images', { merge: true });
   * });
   * ```
   */
  rename(source: string, target: string, options?: MergeOptions): Promise<void>;

  /**
   * Puts a file, or every file below a directory, back as it was in an earlier version, at the same path.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the version doesn't exist or has nothing at `path`.
   * @throws {@link OcflError} `FILE_EXISTS` if a path would become both a file and a directory.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   * @throws `TypeError` if `version` is not a number.
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   // Undo a bad edit: the transcript as it was in version 2
   *   await draft.reinstate('transcript.txt', 2);
   * });
   * ```
   */
  reinstate(path: string, version: number): Promise<void>;

  /**
   * Removes a file, or every file below a directory, from the draft. Earlier versions keep it.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `path` is not in the draft.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.remove('tmp');
   * });
   * ```
   */
  remove(path: string): Promise<void>;

  /**
   * Removes every file from the draft. Earlier versions keep them.
   *
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   // Replace every file: start empty, then import the new set
   *   await draft.clear();
   *   await draft.import('/data/rebuilt/item-1');
   * });
   * ```
   */
  clear(): Promise<void>;

  /**
   * The draft's files: each logical path, with its digest in lowercase in the object's digest algorithm, as `OcflFile.digest` gives it.
   * Directories aren't listed. It takes its turn like any other operation, so it shows every operation started before it, and none started after.
   * The map is a snapshot that later operations don't change. It gives no content.
   *
   * @throws `Error` if the update this draft belongs to has finished.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.import(dir);
   *   const files = await draft.files();
   *   if (!files.has('ro-crate-metadata.json')) await draft.write('ro-crate-metadata.json', stub);
   * });
   * ```
   */
  files(): Promise<ReadonlyMap<string, string>>;
}

/**
 * @param head - The head version's date, which `createdAt` can't be earlier than, if there is a head
 * @returns A copy of `details` holding only what a version records
 * @throws `TypeError` if the message or the user's name is missing or empty, the user's address isn't a string, or `createdAt` isn't a valid `Date` or is earlier than `head`
 */
function checkedDetails(details: VersionDetails, head?: Date): VersionDetails {
  const { message, user, createdAt } = details ?? {};
  if (!isNonEmptyString(message)) {
    throw new TypeError('The message of the version is required.');
  }
  if (!isNonEmptyString(user?.name)) {
    throw new TypeError('The name of the user making the version is required.');
  }
  if (user.address !== undefined && typeof user.address !== 'string') {
    throw new TypeError('The address of the user making the version must be a string.');
  }
  if (createdAt !== undefined) {
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new TypeError(`The createdAt of the version must be a valid Date, not ${inspect(createdAt)}.`);
    }
    if (head && createdAt < head) {
      throw new TypeError(`The createdAt of the version, ${createdAt.toISOString()}, is earlier than the head version's, ${head.toISOString()}.`);
    }
  }
  return {
    message,
    user: { name: user.name, ...(user.address !== undefined && { address: user.address }) },
    ...(createdAt !== undefined && { createdAt: new Date(createdAt) }),
  };
}

function unsupportedContent(content: unknown): TypeError {
  return new TypeError(`Unsupported data type: ${Object.prototype.toString.call(content)}`);
}

function isTextOrBytes(content: unknown): content is string | Uint8Array {
  return typeof content === 'string' || content instanceof Uint8Array;
}

/**
 * @returns `content`; a stream's chunks are checked by {@link hashedBytes} as it is read
 * @throws `TypeError` if `content` is not text, bytes or a stream
 */
function checkedContent(content: unknown): string | Uint8Array | AsyncIterable<unknown> {
  if (isTextOrBytes(content) || isAsyncIterable(content)) {
    return content;
  }
  throw unsupportedContent(content);
}

/** Where the object a draft updates is */
interface ObjectPlace {
  /** Absolute path of the storage root, where removing empty directories stops */
  readonly storageRoot: string;
  /** Absolute path of the object root, inside the storage root */
  readonly objectRoot: string;
  /** Declared when the first commit creates the object */
  readonly ocflVersion: OcflVersion;
}

/** Only {@link ObjectDraft}'s own factory has it, so a draft's class can't make another draft */
const STARTING = Symbol('starting a draft');

/**
 * Writes the object declaration for a create into an empty object root; an update only checks that it is there
 * @returns The path of the declaration file, if this call wrote one
 * @throws {@link OcflError} `INVALID_OBJECT` with `E007` for an invalid declaration, or `E003` if an update finds none; `DIRECTORY_NOT_EMPTY` if a create finds none in a directory that isn't empty
 */
async function ensureObjectDeclaration(root: string, ocflVersion: OcflVersion, creating: boolean): Promise<string | undefined> {
  const declared = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, root);
  if (declared === '') {
    throw createError('E007', root);
  }
  if (declared) {
    return;
  }
  if (!creating) {
    throw createError('E003', root, 'it has an inventory but no object declaration');
  }
  if (!(await fileSystem.isDirEmpty(root))) {
    throw ocflError('DIRECTORY_NOT_EMPTY', 'Cannot create an OCFL Object in a non-empty directory');
  }
  const declaration = NAMASTE_PREFIX_OBJECT + ocflVersion;
  const filePath = path.join(root, NAMASTE_T + declaration);
  await fileSystem.writeFile(filePath, `${declaration}\n`);
  return filePath;
}

/** The head the root inventory `content` names: `undefined` if there is no root inventory, `null` if it names none */
function headOf(content: string | undefined): string | null | undefined {
  if (content === undefined) {
    return undefined;
  }
  const head = parseJsonObject(content)?.head;
  return typeof head === 'string' ? head : null;
}

function readRootInventory(objectRoot: string): Promise<string | undefined> {
  return fileSystem.readIfExists(path.join(objectRoot, INVENTORY_NAME));
}

/** The head the root inventory on disk names, as {@link headOf} gives it */
async function headOnDisk(objectRoot: string): Promise<string | null | undefined> {
  return headOf(await readRootInventory(objectRoot));
}

/**
 * Checks that the version before the head of `inventory` is still the head on disk, in the root inventory it was made from.
 * @param inventory - Already at its new version
 * @throws {@link OcflError} `OBJECT_EXISTS` if `inventory` is at its first version and the object now has a root inventory
 * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if the head on disk is any other version, or the root inventory has been replaced: the object removed and created again
 */
async function assertUpToDate(objectRoot: string, inventory: OcflObjectInventory): Promise<void> {
  const expected = inventory.versionNumber.previous()?.toString();
  const content = await readRootInventory(objectRoot);
  const actual = headOf(content);
  if (actual === expected) {
    const madeFrom = inventory._madeFrom;
    if (content === undefined || madeFrom === undefined || (await Hashing.digest(inventory.digestAlgorithm, content)) === madeFrom) {
      return;
    }
    throw ocflError(
      'OBJECT_OUT_OF_DATE',
      `The object at ${objectRoot} was opened at ${expected}, and its root inventory has been replaced since. Open it again and retry.`,
    );
  }
  if (expected === undefined) {
    throw ocflError('OBJECT_EXISTS', `There is already an object at ${objectRoot}.`);
  }
  const found = actual === undefined ? 'no root inventory' : actual === null ? 'a root inventory with no head' : `the head ${actual}`;
  throw ocflError('OBJECT_OUT_OF_DATE', `The object at ${objectRoot} was opened at ${expected}, and now has ${found}. Open it again and retry.`);
}

/**
 * For an update that ended holding its lock: it may be committed, or may have left files behind.
 * @param cause - What the update failed with
 */
function recoveryNeeded(objectRoot: string, state: string, cause: unknown) {
  return lockKept(`The update of the object at ${objectRoot} ${state}`, 'then open the object again before retrying', cause);
}

/**
 * @returns Whether `options` asks for a merge
 * @throws `TypeError` if `options` is given and is not an object, or its `merge` is given and is not a boolean
 */
function mergeOption(options: unknown): boolean {
  if (options === undefined) {
    return false;
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`Options must be an object, such as { merge: true }, not ${inspect(options)}`);
  }
  const { merge } = options as { merge?: unknown };
  if (merge !== undefined && typeof merge !== 'boolean') {
    throw new TypeError(`The merge option must be a boolean, not ${inspect(merge)}`);
  }
  return merge === true;
}

function isAsyncIterable(data: unknown): data is AsyncIterable<unknown> {
  return typeof (data as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === 'function';
}

/** @throws `TypeError` at the first chunk that is not text or bytes */
async function* hashedBytes(source: AsyncIterable<unknown>, hash: ReturnType<typeof Hashing.createHasher>) {
  for await (const chunk of source) {
    if (!isTextOrBytes(chunk)) {
      throw unsupportedContent(chunk);
    }
    const bytes = Hashing.toBytes(chunk);
    hash.update(bytes);
    yield bytes;
  }
}

/** Files imports read or copy at once, across all the imports in a draft */
const IMPORT_CONCURRENCY = 10;

interface ImportFile {
  source: string;
  logicalPath: string;
}

interface HashedImportFile extends ImportFile {
  digest: string;
}

/** Every file under `source`, with the logical path it becomes */
async function listImportFiles(source: string, target: string | undefined): Promise<ImportFile[]> {
  const base = target === undefined ? undefined : importTarget(target);
  const stat = await fs.promises.lstat(source);
  if (stat.isFile()) {
    return [{ source, logicalPath: base ?? path.basename(source) }];
  }
  if (!stat.isDirectory()) {
    throw unsupportedFileType(source);
  }
  const files: ImportFile[] = [];
  for (const entry of await fs.promises.readdir(source, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile()) {
      files.push({ source: file, logicalPath: path.posix.join(base ?? '', ...path.relative(source, file).split(path.sep)) });
    } else if (!entry.isDirectory()) {
      throw unsupportedFileType(file);
    }
  }
  return files;
}

/** `target` in the form copy() and rename() store, so two spellings of one path are the same path */
function importTarget(target: string) {
  checkLogicalPath(target);
  const normalised = normaliseLogicalPath(target);
  if (normalised === '.') {
    throw ocflError('INVALID_LOGICAL_PATH', "An import target can't be empty; leave it out to import a directory's contents at the object root");
  }
  return normalised;
}

function unsupportedFileType(filePath: string) {
  return ocflError('UNSUPPORTED_FILE_TYPE', `"${filePath}" is not a regular file or directory`);
}

interface TrackedPromise<T> extends Promise<T> {
  done?: boolean;
}

/**
 * Runs `change` on a draft of the version `inventory` is at, then commits it, or discards it if `change` throws.
 * @param inventory - Already at its new version
 * @returns The committed inventory, or `undefined` if the draft ended the same as the previous version
 */
let commitDraft: (
  place: ObjectPlace,
  inventory: OcflObjectInventory,
  details: VersionDetails,
  change: (draft: Draft) => Promise<unknown>,
  signal: AbortSignal | undefined,
) => Promise<OcflObjectInventory | undefined>;

/**
 * Operations called concurrently, such as with `Promise.all`, give the same result as awaiting
 * them one after another in the order they were called. A failed operation
 * rejects its own promise and leaves nothing behind; later operations carry on. An operation
 * waits for all the earlier ones, so one whose input never ends holds up those called after it.
 * If a failed operation's changes to the stored files can't be undone, the commit discards the draft and throws that operation's error.
 *
 * The draft is committed when the root inventory is replaced. A failure before that discards everything
 * the draft made and releases the object's lock. A failure after it, a failed replacement that may have
 * happened all the same, or a failure to discard, throws `RECOVERY_NEEDED` and keeps the lock.
 */
class ObjectDraft implements Draft {
  #versionPath: string;
  #contentRoot: string;
  #place: ObjectPlace;
  #workspace: string;
  #inventory: OcflObjectInventory;
  #rootExisted: boolean;
  #createdNamaste: string | undefined;
  #rootInventoryStaged = false;
  #queue: TrackedPromise<unknown>[] = [];
  #lastTurn: Promise<unknown> = Promise.resolve();
  #stagedCount = 0;
  #finished = false;
  #commitBlocker: { error: unknown } | undefined;
  #limit = createLimiter(IMPORT_CONCURRENCY);
  #signal: AbortSignal | undefined;

  // Inside the class so it reaches the private commit and discard, which neither a draft nor its class exposes
  static {
    commitDraft = async (place, inventory, details, change, signal) => {
      signal?.throwIfAborted();
      const draft = await ObjectDraft.#start(place, inventory, signal);
      try {
        await change(draft);
      } catch (error) {
        // Decided as the callback settles, not after the discard, which a late abort mustn't turn into a cancellation
        const cancelled = signal?.aborted ? { reason: signal.reason } : undefined;
        await draft.#discard({ error });
        throw cancelled ? cancelled.reason : error;
      }
      return draft.#commit(details);
    };
  }

  private constructor(
    starting: symbol,
    place: ObjectPlace,
    workspace: string,
    inventory: OcflObjectInventory,
    versionPath: string,
    rootExisted: boolean,
    signal: AbortSignal | undefined,
  ) {
    if (starting !== STARTING) {
      throw new TypeError('A draft is made only by an update.');
    }
    this.#versionPath = versionPath;
    this.#contentRoot = path.join(versionPath, inventory.contentDirectory);
    this.#place = place;
    this.#workspace = workspace;
    this.#inventory = inventory;
    this.#rootExisted = rootExisted;
    this.#signal = signal;
  }

  static async #start(place: ObjectPlace, inventory: OcflObjectInventory, signal: AbortSignal | undefined) {
    const { storageRoot, objectRoot } = place;
    const workspace = objectWorkspace(storageRoot, objectRoot);
    const rootExisted = await fs.promises.stat(objectRoot).then(
      () => true,
      () => false,
    );
    await takeLock(workspace, storageRoot, inventory.id, rootExisted);
    const versionPath = path.join(workspace, inventory.head);
    const refuse = async (error: unknown): Promise<never> => {
      try {
        await releaseLock(workspace, storageRoot);
      } catch {
        throw recoveryNeeded(objectRoot, 'was refused, and its lock could not be released', error);
      }
      throw error;
    };
    await assertUpToDate(objectRoot, inventory).catch(refuse);
    try {
      await fs.promises.mkdir(versionPath);
    } catch (error) {
      // Kept locked, so that what an earlier writer left there never becomes part of a version
      if (fileSystem.isAlreadyExists(error)) {
        throw lockKept(
          `The object at ${objectRoot} can't be updated: an earlier update left ${versionPath} behind`,
          'then open the object again before retrying',
          error,
        );
      }
      return refuse(error);
    }
    return new ObjectDraft(STARTING, place, workspace, inventory, versionPath, rootExisted, signal);
  }

  #getRealPath(logicalPath: string) {
    checkLogicalPath(logicalPath);
    // Defence in depth: only a Windows drive-relative path such as C:x gets past checkLogicalPath
    /* node:coverage disable */
    if (fileSystem.relativeWithin(path.resolve(this.#contentRoot), logicalPath) === undefined) {
      throw invalidLogicalPath(logicalPath);
    }
    /* node:coverage enable */
    return path.join(this.#contentRoot, path.normalize(logicalPath));
  }

  /**
   * Discards everything this draft made.
   * @param failure - What the update failed with, if it did, which the caller then throws
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if something the draft made can't be removed; `cause` is the failure, or else what stopped the removal
   */
  async #discard(failure?: { error: unknown }): Promise<void> {
    // Before waiting, so no operation started meanwhile is accepted and then overlaps the undo
    this.#finished = true;
    await Promise.allSettled(this.#queue);
    try {
      await this.#undo();
    } catch (undoFailure) {
      throw recoveryNeeded(this.#place.objectRoot, 'was not committed, and what it made could not all be removed', failure ? failure.error : undoFailure);
    }
  }

  /**
   * Saves the draft as the object's new version, or discards it if it is the same as the previous version.
   * @param details - Recorded in the version entry of the inventory
   * @returns The committed inventory, or `undefined` if there were no changes
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if the commit failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made can't be removed; `cause` is the failure
   */
  async #commit(details: VersionDetails): Promise<OcflObjectInventory | undefined> {
    this.#finished = true;
    const changed = this.#inventory._isChanged;
    let unconfirmed: { error: unknown } | undefined;
    try {
      this.#signal?.throwIfAborted();
      const count = this.#queue.filter((p) => !p.done).length;
      if (count > 0) {
        throw new Error(`Unfinished operations detected (${count}). Make sure the callback is an async function that awaits every operation it starts.`);
      }
      if (this.#commitBlocker) {
        throw this.#commitBlocker.error;
      }
      if (changed) {
        unconfirmed = await this.#replaceRootInventory(details);
      }
    } catch (error) {
      await this.#discard({ error });
      throw error;
    }
    if (!changed) {
      await this.#discard();
      return;
    }
    if (unconfirmed) {
      throw recoveryNeeded(
        this.#place.objectRoot,
        'may have been committed: replacing its root inventory failed, but may have taken effect',
        unconfirmed.error,
      );
    }
    try {
      const rootInv = this.#rootInventoryPaths;
      await fileSystem.move(rootInv.stagedSidecar, rootInv.sidecar);
      await this.#releaseLock();
    } catch (error) {
      throw recoveryNeeded(this.#place.objectRoot, 'was committed, but could not be finished', error);
    }
    return this.#inventory;
  }

  /**
   * Remove everything this draft created, including an object root it made and the layout directories above it that that leaves empty,
   * then release the lock. Only before the root inventory is replaced: nothing puts a replaced root inventory back.
   */
  async #undo() {
    const root = this.#place.objectRoot;
    const rootInv = this.#rootInventoryPaths;
    if (this.#rootInventoryStaged) {
      await fs.promises.rm(rootInv.stagedInventory, { recursive: true, force: true });
      await fs.promises.rm(rootInv.stagedSidecar, { recursive: true, force: true });
    }
    await fs.promises.rm(this.#versionPath, { recursive: true, force: true });
    if (this.#createdNamaste) {
      await fs.promises.rm(this.#createdNamaste, { recursive: true, force: true });
    }
    if (!this.#rootExisted) {
      await fileSystem.removeEmptyAncestorsQuietly(root, this.#place.storageRoot);
    }
    await this.#releaseLock();
  }

  async #releaseLock() {
    await releaseLock(this.#workspace, this.#place.storageRoot);
  }

  get #rootInventoryPaths() {
    return rootInventoryPaths(this.#place.objectRoot, this.#inventory.digestAlgorithm);
  }

  /**
   * Every step of the commit up to its commit point, the replacement of the root inventory, which is the last thing this does.
   * @returns The failure of a replacement that may have happened all the same, which mustn't be undone
   */
  async #replaceRootInventory(details: VersionDetails): Promise<{ error: unknown } | undefined> {
    const inventory = this.#inventory;
    const digestAlgorithm = inventory.digestAlgorithm;
    inventory._stamp((details.createdAt ?? new Date()).toISOString(), details.message, details.user);

    const objectVersionPath = path.join(this.#place.objectRoot, inventory.head);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json */
    let invPath = path.join(this.#versionPath, INVENTORY_NAME);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json.sha512 */
    let invDigestPath = `${invPath}.${digestAlgorithm}`;

    const inventoryContent = inventory.toString();
    inventory._digest = await Hashing.digest(digestAlgorithm, inventoryContent);
    const digest = sidecarContent(inventory);

    // write inventory.json to workspace
    await fileSystem.writeFile(invPath, inventoryContent);
    await fileSystem.writeFile(invDigestPath, digest);
    // Before anything in the object root changes, so a moved head never surfaces as a failed rename
    await assertUpToDate(this.#place.objectRoot, inventory);
    const creating = inventory.versionNumber.previous() === undefined;
    this.#createdNamaste = await ensureObjectDeclaration(this.#place.objectRoot, this.#place.ocflVersion, creating);
    try {
      await fileSystem.move(this.#versionPath, objectVersionPath);
    } catch (error) {
      throw fileSystem.hasErrorCode(error, 'EXDEV')
        ? ocflError(
            'CROSS_FILESYSTEM_MOVE',
            `Cannot move the new version into "${this.#place.objectRoot}": it is on a different filesystem from the workspace.`,
          )
        : error;
    }
    this.#versionPath = objectVersionPath;
    // replace root inventory
    const rootInv = this.#rootInventoryPaths;
    /* eg: /data/aa/bb/cc/object-1/v1/inventory.json */
    invPath = path.join(objectVersionPath, INVENTORY_NAME);
    invDigestPath = `${invPath}.${digestAlgorithm}`;
    this.#rootInventoryStaged = true;
    await fileSystem.copyFile(invPath, rootInv.stagedInventory);
    await fileSystem.copyFile(invDigestPath, rootInv.stagedSidecar);
    // A rename keeps it, and no other writer can replace the root inventory while this one holds the lock
    inventory._identity = await fileSystem.identityOf(rootInv.stagedInventory);
    try {
      await fileSystem.move(rootInv.stagedInventory, rootInv.inventory);
    } catch (error) {
      // On NFS a rename can be applied though its reply is lost, so only the old head on disk, or for a create no root inventory, shows it
      // wasn't. A root inventory that can't be read or names no head counts as replaced
      const notReplaced = await headOnDisk(this.#place.objectRoot).then(
        (head) => head === inventory.versionNumber.previous()?.toString(),
        () => false,
      );
      if (notReplaced) {
        throw error;
      }
      return { error };
    }
  }

  /** Content waits here, outside the content directory, until its digest decides whether it's kept */
  #stagingPath() {
    return path.join(this.#versionPath, `.staged-${++this.#stagedCount}`);
  }

  async #removeStagedOnFailure<T>(staging: string, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      await fileSystem.removeQuietly(staging);
      throw error;
    }
  }

  /**
   * Must run in the operation's turn.
   * @param stage - Fills `staging`, if it isn't already, once the content is known to be needed
   */
  async #addContent(logicalPath: string, digest: string, staging: string, stage?: () => Promise<void>) {
    const inventory = this.#inventory;
    const releases = inventory.getDigest(logicalPath) === digest ? [] : inventory._contentReleases([logicalPath]);
    const isNew = !inventory.getContentPath(digest);
    await this.#removeStagedOnFailure(staging, async () => {
      // _add checks too, but only once the content has been placed
      inventory._checkFilePath(logicalPath);
      const realPath = isNew ? this.#getRealPath(logicalPath) : undefined;
      if (isNew) {
        await stage?.();
      }
      await this.#applyContentReleases(releases, realPath, async () => {
        if (realPath) {
          await fileSystem.move(staging, realPath);
        } else if (!stage) {
          await fs.promises.rm(staging, { recursive: true, force: true });
        }
      });
    });
    inventory._add(logicalPath, digest);
  }

  /**
   * Make releases' changes to the stored files around `place`. If a move or `place` fails, every move is undone and no directory it made is left.
   * @param placedAt - The file `place` fills, if it stores any content
   */
  async #applyContentReleases(releases: ContentRelease[], placedAt?: string, place?: () => Promise<void>) {
    const files = releases.map(({ from, to }) => ({
      from: this.#contentFilePath(from),
      to: to === undefined ? undefined : this.#contentFilePath(to),
    }));
    const targets = new Set(files.map(({ to }) => to));
    // A file a move would overwrite is set aside first, so it can still be moved on, or put back after a failure
    const setAside = files.filter(({ from }) => targets.has(from)).map(({ from }) => ({ from, to: this.#stagingPath() }));
    const asideAt = new Map(setAside.map(({ from, to }) => [from, to]));
    const remaining = files.map(({ from, to }) => ({ from: asideAt.get(from) ?? from, to }));
    const moved: { from: string; to: string }[] = [];
    // Where the step in progress puts a file, creating the directories above it
    let filling: string | undefined;
    try {
      for (const { from, to } of [...setAside, ...remaining]) {
        if (to !== undefined) {
          filling = to;
          await fileSystem.move(from, to);
          moved.push({ from, to });
        }
      }
      filling = placedAt;
      await place?.();
    } catch (error) {
      try {
        if (filling !== undefined) {
          await this.#pruneEmptyDirectories(path.dirname(filling));
        }
        for (const { from, to } of moved.reverse()) {
          await fileSystem.move(to, from);
          await this.#pruneEmptyDirectories(path.dirname(to));
        }
      } catch {
        this.#blockCommit(error);
      }
      throw error;
    }
    const vacated = files.filter(({ from }) => from !== placedAt);
    await this.#blockCommitOnFailure(async () => {
      for (const { from, to } of remaining) {
        if (to === undefined && from !== placedAt) {
          await fs.promises.rm(from, { recursive: true, force: true });
        }
      }
    });
    for (const dir of new Set(vacated.map(({ from }) => path.dirname(from)))) {
      await this.#pruneEmptyDirectories(dir);
    }
  }

  /** For a file change that can't be reversed if it fails, which leaves the files and inventory out of step */
  async #blockCommitOnFailure(change: () => Promise<void>) {
    try {
      await change();
    } catch (error) {
      this.#blockCommit(error);
      throw error;
    }
  }

  /** @param error - What the operation that left the files and inventory out of step rejects with, which the commit then throws */
  #blockCommit(error: unknown) {
    this.#commitBlocker ??= { error };
  }

  #contentFilePath(contentPath: string) {
    return path.join(path.dirname(this.#versionPath), contentPath);
  }

  /** A version shouldn't contain empty directories, so remove any at or above `start`, up to and including the content directory */
  async #pruneEmptyDirectories(start: string) {
    await fileSystem.removeEmptyAncestorsQuietly(start, this.#versionPath);
  }

  async write(logicalPath: string, data: WriteContent): Promise<void> {
    // Before the content check, so a finished draft refuses any content with the same Error
    this.#assertOpen();
    const checked = checkedContent(data);
    // Copied now: the caller may change their buffer before this write's turn
    const content = checked instanceof Uint8Array ? new Uint8Array(checked) : checked;
    return this.#inTurn(async () => {
      const target = fileLogicalPath(logicalPath);
      const digestAlgo = this.#inventory.digestAlgorithm;
      const staging = this.#stagingPath();
      if (isAsyncIterable(content)) {
        const hash = Hashing.createHasher(digestAlgo);
        await this.#removeStagedOnFailure(staging, () => fileSystem.writeFile(staging, hashedBytes(content, hash)));
        const digest = hash.digest();
        return () => this.#addContent(target, digest, staging);
      }
      const digest = await Hashing.digest(digestAlgo, content);
      return () => this.#addContent(target, digest, staging, () => fileSystem.writeFile(staging, content));
    });
  }

  /** The source was hashed before the copy, so the copy is hashed too, to check they're the same bytes */
  async #stageImportedFile(source: string, staging: string, digest: string) {
    await fileSystem.copyFile(source, staging);
    if ((await Hashing.digest(this.#inventory.digestAlgorithm, fileSystem.createReadable(staging))) !== digest) {
      throw ocflError('SOURCE_CHANGED', `"${source}" changed while it was being imported`);
    }
  }

  /** @returns the step that adds the prepared files, which must run in the import's turn */
  async #prepareImport(source: string, target: string | undefined): Promise<() => Promise<void>> {
    const files = await listImportFiles(source, target);
    const algorithm = this.#inventory.digestAlgorithm;
    const hashed = await Promise.all(
      files.map((file) =>
        this.#limited(() => Hashing.digest(algorithm, fileSystem.createReadable(file.source))).then(
          (digest) => ({ ...file, digest }),
          (error: unknown) => ({ ...file, error }),
        ),
      ),
    );
    return async () => {
      for (const { logicalPath } of files) {
        this.#inventory._checkFilePath(logicalPath);
      }
      const readable = hashed.map((file) => {
        if (!('digest' in file)) {
          throw file.error;
        }
        return file;
      });
      const staged = await this.#stageImport(readable);
      // Past here a failure can't be put back: files the import replaced are already gone
      await this.#blockCommitOnFailure(async () => {
        for (const { logicalPath, digest } of readable) {
          const staging = staged.get(digest) ?? this.#stagingPath();
          staged.delete(digest);
          await this.#addContent(logicalPath, digest, staging);
        }
      });
    };
  }

  /**
   * Copy in the content the object won't otherwise hold once `files` are added, changing neither the inventory nor the content directory.
   * @returns Where each digest's content is staged
   */
  async #stageImport(files: HashedImportFile[]): Promise<Map<string, string>> {
    const imported = new Map(files.map(({ logicalPath, digest }) => [logicalPath, digest]));
    const staged = new Map<string, string>();
    try {
      for (const { source, digest } of files) {
        if (!staged.has(digest) && !this.#keepsContent(digest, imported)) {
          const staging = this.#stagingPath();
          staged.set(digest, staging);
          await this.#limited(() => this.#stageImportedFile(source, staging, digest));
        }
      }
    } catch (error) {
      await Promise.all(Array.from(staged.values(), fileSystem.removeQuietly));
      throw error;
    }
    return staged;
  }

  /**
   * Whether the object still holds the content of `digest` once the files of `imported` have replaced those at their logical paths
   * @param imported - The digest each logical path is given
   */
  #keepsContent(digest: string, imported: Map<string, string>) {
    const inventory = this.#inventory;
    const contentPath = inventory.getContentPath(digest);
    if (contentPath === undefined) {
      return false;
    }
    // Only content this version stored is removed when its last file is replaced
    return (
      !contentPath.startsWith(`${inventory.head}/`) || inventory._headFiles(digest).some((logicalPath) => (imported.get(logicalPath) ?? digest) === digest)
    );
  }

  // A failed import adds nothing, unless a copied file can't be put in place, which fails the commit
  async import(source: string, target?: string): Promise<void> {
    return this.#inTurn(() => this.#prepareImport(source, target));
  }

  async copy(source: string, target: string, options?: MergeOptions): Promise<void> {
    return this.#operate(async () => {
      const merge = mergeOption(options);
      const plan = this.#inventory._planCopy(fileLogicalPath(source), fileLogicalPath(target), merge);
      await this.#applyRelist(plan);
    });
  }

  // Content this version stored moves with its path; earlier versions' content stays where the manifest has it
  async rename(source: string, target: string, options?: MergeOptions): Promise<void> {
    return this.#operate(async () => {
      const merge = mergeOption(options);
      const plan = this.#inventory._planRename(fileLogicalPath(source), fileLogicalPath(target), merge);
      await this.#applyRelist(plan);
    });
  }

  async reinstate(logicalPath: string, version: number): Promise<void> {
    return this.#operate(async () => {
      if (typeof version !== 'number') {
        throw new TypeError(`The version must be a number, such as 1, not ${inspect(version)}`);
      }
      const plan = this.#inventory._planReinstate(fileLogicalPath(logicalPath), version);
      await this.#applyRelist(plan);
    });
  }

  async remove(logicalPath: string): Promise<void> {
    return this.#operate(async () => {
      const inventory = this.#inventory;
      const plan = inventory._planDelete(fileLogicalPath(logicalPath));
      if (plan.paths.length === 0) {
        throw ocflError('FILE_NOT_FOUND', `Logical path "${logicalPath}" does not exist in object [${inventory.id}]`);
      }
      await this.#applyDelete(plan);
    });
  }

  async clear(): Promise<void> {
    return this.#operate(() => this.#applyDelete(this.#inventory._planClear()));
  }

  async files(): Promise<ReadonlyMap<string, string>> {
    return this.#operate(async () => {
      const inventory = this.#inventory;
      return new Map(Array.from(inventory.files(inventory.head), ({ logicalPath, digest }) => [logicalPath, digest]));
    });
  }

  async #applyRelist(plan: RelistPlan) {
    await this.#applyContentReleases(plan.releases);
    this.#inventory._applyRelist(plan);
  }

  async #applyDelete(plan: DeletePlan) {
    await this.#applyContentReleases(plan.releases);
    this.#inventory._applyDelete(plan);
  }

  /** `#inTurn` for an operation with nothing to prepare */
  async #operate<T>(op: () => Promise<T>): Promise<T> {
    return this.#inTurn(async () => op);
  }

  /**
   * Runs an operation in its turn, once the draft is checked to be open, and tracks it until it settles.
   * `prepare` starts straight away and may overlap other operations, so it mustn't touch the
   * inventory or content directory. The step it resolves to runs once every operation called
   * earlier has finished.
   */
  async #inTurn<T>(prepare: () => Promise<() => Promise<T>>): Promise<T> {
    this.#assertOpen();
    this.#signal?.throwIfAborted();
    const prepared = prepare();
    // A rejection surfaces at this operation's turn, which may come much later
    prepared.catch(() => {});
    // Prepared first, so nothing an operation started is still writing once the update is discarded
    const turn = this.#lastTurn.then(async () => {
      const step = await prepared;
      this.#signal?.throwIfAborted();
      return step();
    });
    this.#lastTurn = turn.catch(() => {});
    return this.#track(turn);
  }

  /** Runs `task` within the draft's limit on files read at once, unless the update's signal is aborted by its turn */
  #limited<T>(task: () => Promise<T>): Promise<T> {
    return this.#limit(async () => {
      this.#signal?.throwIfAborted();
      return task();
    });
  }

  #assertOpen() {
    if (this.#finished) {
      throw new Error('The update this draft belongs to has finished.');
    }
  }

  #track<T>(p: TrackedPromise<T>): Promise<T> {
    const markDone = () => {
      p.done = true;
    };
    // then(f, f), not finally(f): finally's derived promise would reject unhandled.
    p.then(markDone, markDone);
    this.#queue.push(p);
    return p;
  }
}

export { checkedDetails, commitDraft, type Draft, type MergeOptions, type UpdateOptions, type User, type VersionDetails, type WriteContent };
