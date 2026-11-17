import fs, { type Dirent } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { type ObjectPlace, startWrite } from './commit.ts';
import * as Hashing from './digest.ts';
import { ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { ContentRelease, DeletePlan, OcflObjectInventory, RelistPlan } from './inventory.ts';
import { checkLogicalPath, fileLogicalPath, invalidLogicalPath, normaliseLogicalPath } from './logical-path.ts';
import { createLimiter, functionOption, isJsonObject, isNonEmptyString, optionsObject, rejectUnknownKeys, signalOption } from './utils.ts';

/** The person or system responsible for a version. */
interface User {
  /** Display name: a person's, or the software's when no person makes the version. */
  readonly name: string;
  /** A URI for the user, such as `mailto:`, an ORCID, or the URL of software acting as the user. */
  readonly address?: string;
}

/**
 * What a new version records about why and by whom it was made.
 * A job with no person behind it names the software as the user, and says in the message what it did and where the content came from.
 */
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

/** Options for `OcflObject.update`: what the new version records, and how the update behaves. */
interface UpdateOptions extends VersionDetails {
  /**
   * Cancels the update when aborted: draft operations started after that reject with its reason, and the draft is discarded once the callback settles.
   * It is checked one last time just before the commit begins, and ignored after that. It isn't recorded in the version.
   *
   * @example
   * ```ts
   * await object.update({ message, user, signal: request.signal }, (draft) => draft.import(dir));
   * ```
   */
  readonly signal?: AbortSignal | undefined;
}

/** Options for `StorageRoot.create`: what the first version records, and how the create behaves. */
interface CreateOptions extends VersionDetails {
  /**
   * Cancels the create when aborted: draft operations started after that reject with its reason, and the draft is discarded once the callback settles.
   * It is checked one last time just before the commit begins, and ignored after that. It isn't recorded in the version.
   *
   * @example
   * ```ts
   * await root.create(id, { message, user, signal: request.signal }, (draft) => draft.import(dir));
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

/** Options for {@link Draft.import}. */
interface ImportOptions {
  /** Where in the draft the files go. Leave it out for the top. */
  readonly target?: string | undefined;
  /**
   * Called for each entry below a directory `source`, with its path relative to `source` using `/`, such as `sub/.DS_Store`.
   * Return `false` to leave the entry out; a directory left out is not read. Not called when `source` is a file.
   *
   * @example
   * ```ts
   * await draft.import('/data/crate', {
   *   filter: (_, entry) => entry.name !== '.git' && entry.name !== '.DS_Store' && !entry.name.startsWith('._') && !entry.isSymbolicLink(),
   * });
   * ```
   */
  readonly filter?: ((relativePath: string, entry: Dirent) => boolean) | undefined;
}

/** A file in a draft, as {@link Draft.files} lists it. */
interface DraftFile {
  /** Logical path within the draft, such as `audio/1.wav`: the file's key in {@link Draft.files}. */
  readonly path: string;
  /** Lowercase hex digest of the content, in the object's `OcflObject.digestAlgorithm`. */
  readonly digest: string;
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
   * @throws {@link OcflError} `PATH_CONFLICT` if `path` is a directory, or lies below a file.
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
   * Copies a file or directory from disk into the draft, at the `target` option or at the top. Files already there are replaced; the rest stay.
   *
   * Without a `target`, a directory's contents go at the top and a file keeps its own name there.
   * Everything below a directory is copied, including hidden files, except entries the `filter` option leaves out.
   * If a file fails, the first failure is thrown and the draft is left as it was.
   *
   * @throws {@link OcflError} `UNSUPPORTED_FILE_TYPE` if `source` is anything but a regular file or directory, such as a symlink, or contains one the filter keeps.
   * @throws {@link OcflError} `SOURCE_CHANGED` if a file changed while it was being read.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `target` is empty or leaves the object.
   * @throws {@link OcflError} `PATH_CONFLICT` if a path would become both a file and a directory.
   * @throws `TypeError` if `options` is not an object, has a key other than `target` and `filter`, `target` is not a string, `filter` is not a function or it returns anything but `true` or `false`.
   * @throws `Error` if the update this draft belongs to has finished.
   * @throws The error `filter` throws.
   * @throws The file system error if `source`, or something below it, is missing or can't be read.
   * @example
   * ```ts
   * await object.update(details, async (draft) => {
   *   await draft.import('/data/incoming/item-1', { target: 'raw' });
   * });
   * ```
   */
  import(source: string, options?: ImportOptions): Promise<void>;

  /**
   * Copies a file, or every file below a directory, to `target` within the draft.
   * With `merge`, a directory goes file by file into a `target` that has files: files at the same path are replaced and the rest stay.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` is not in the draft.
   * @throws {@link OcflError} `TARGET_NOT_EMPTY` if `source` is a directory and `target` already has files, unless `merge` is set.
   * @throws {@link OcflError} `PATH_CONFLICT` if a file would go where a directory is, or below a file, as the draft stands before the operation.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`.
   * @throws `TypeError` if `options` is given and is not an object, has a key other than `merge`, or its `merge` is given and is not a boolean.
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
   * @throws {@link OcflError} `TARGET_NOT_EMPTY` if `source` is a directory and `target` already has files, unless `merge` is set.
   * @throws {@link OcflError} `PATH_CONFLICT` if a file would go where a directory is, or below a file, as the draft stands before the operation.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`.
   * @throws `TypeError` if `options` is given and is not an object, has a key other than `merge`, or its `merge` is given and is not a boolean.
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
   * @throws {@link OcflError} `VERSION_NOT_FOUND` if the object has no committed version with this number.
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the version has nothing at `path`.
   * @throws {@link OcflError} `PATH_CONFLICT` if a path would become both a file and a directory.
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
   * The draft's files: a {@link DraftFile} for each logical path, whose `digest` is as `OcflFile.digest` gives it.
   * Directories aren't listed. It takes its turn like any other operation, so it shows every operation started before it, and none started after.
   * The map and its files are a snapshot that later operations don't change. It gives no content.
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
  files(): Promise<ReadonlyMap<string, DraftFile>>;
}

/**
 * The options of `object.update` and `root.create`, split into what the version records and the signal.
 * @param call - The call as a caller writes it, e.g. `object.update`
 * @param head - The head version's date, which `createdAt` can't be earlier than, if there is a head
 * @throws `TypeError` if `options` isn't an object, has a key other than `message`, `user`, `createdAt` and `signal`, its user has one other than `name` and `address`, the message or the user's name is missing or empty, the user's address isn't a string, `createdAt` isn't a valid `Date` or is earlier than `head`, or `signal` isn't an `AbortSignal`
 */
function writeOptions(options: unknown, call: string, head?: Date): { details: VersionDetails; signal: AbortSignal | undefined } {
  const { signal, ...details } = optionsObject(options, call, ['message', 'user', 'createdAt', 'signal'], "{ message: 'Add a file', user: { name: 'Alice' } }");
  return { details: checkedDetails(details as Partial<VersionDetails>, head), signal: signalOption(signal) };
}

/** @returns A copy of `details` holding only what a version records */
function checkedDetails({ message, user, createdAt }: Partial<VersionDetails>, head: Date | undefined): VersionDetails {
  if (!isNonEmptyString(message)) {
    throw new TypeError('The message of the version is required.');
  }
  if (isJsonObject(user)) {
    rejectUnknownKeys(user, ['name', 'address'], 'The user making the version has no field');
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

/** Only {@link commitDraft} has it, so a draft's class can't make another draft */
const STARTING = Symbol('starting a draft');

/** @returns Whether `options` asks for a merge */
function mergeOption(options: unknown, call: string): boolean {
  const { merge } = optionsObject(options, call, ['merge'], '{ merge: true }');
  if (merge !== undefined && typeof merge !== 'boolean') {
    throw new TypeError(`The merge option must be a boolean, not ${inspect(merge)}`);
  }
  return merge === true;
}

function importOptions(options: unknown): ImportOptions {
  const checked = optionsObject(options, 'draft.import', ['target', 'filter'], "{ target: 'raw' }");
  if (checked.target !== undefined && typeof checked.target !== 'string') {
    throw new TypeError(`The target option must be a string, not ${inspect(checked.target)}`);
  }
  functionOption('filter', checked.filter);
  return checked as ImportOptions;
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
async function listImportFiles(source: string, { target, filter }: ImportOptions): Promise<ImportFile[]> {
  const base = target === undefined ? undefined : importTarget(target);
  const stat = await fs.promises.lstat(source);
  if (stat.isFile()) {
    return [{ source, logicalPath: base ?? path.basename(source) }];
  }
  if (!stat.isDirectory()) {
    throw unsupportedFileType(source);
  }
  const files: ImportFile[] = [];
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (filter !== undefined && !keeps(filter, relativePath, entry)) {
        continue;
      }
      if (entry.isFile()) {
        files.push({ source: file, logicalPath: path.posix.join(base ?? '', relativePath) });
      } else if (entry.isDirectory()) {
        await walk(file, relativePath);
      } else {
        throw unsupportedFileType(file);
      }
    }
  };
  await walk(source, '');
  return files;
}

function keeps(filter: NonNullable<ImportOptions['filter']>, relativePath: string, entry: Dirent): boolean {
  const kept: unknown = filter(relativePath, entry);
  if (typeof kept !== 'boolean') {
    throw new TypeError(`The filter must return true or false, not ${inspect(kept)}`);
  }
  return kept;
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
 * Runs a draft's operations in turn, and says whether the draft may be committed.
 * Operations called concurrently, such as with `Promise.all`, give the same result as awaiting
 * them one after another in the order they were called. A failed operation
 * rejects its own promise and leaves nothing behind; later operations carry on. An operation
 * waits for all the earlier ones, so one whose input never ends holds up those called after it.
 * If a failed operation's changes to the stored files can't be undone, the commit discards the draft and throws that operation's error.
 */
class Turns {
  #queue: TrackedPromise<unknown>[] = [];
  #lastTurn: Promise<unknown> = Promise.resolve();
  #finished = false;
  #commitBlocker: { error: unknown } | undefined;
  #signal: AbortSignal | undefined;

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
  }

  /**
   * Runs an operation in its turn, once the draft is checked to be open, and tracks it until it settles.
   * `prepare` starts straight away and may overlap other operations, so it mustn't touch the
   * inventory or content directory. The step it resolves to runs once every operation called
   * earlier has finished.
   */
  run<T>(prepare: () => Promise<() => Promise<T>>): Promise<T> {
    this.assertOpen();
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

  throwIfAborted() {
    this.#signal?.throwIfAborted();
  }

  assertOpen() {
    if (this.#finished) {
      throw new Error('The update this draft belongs to has finished.');
    }
  }

  /** @param error - What the operation that left the files and inventory out of step rejects with, which the commit then throws */
  blockCommit(error: unknown) {
    this.#commitBlocker ??= { error };
  }

  /** Refuses any further operation */
  close() {
    this.#finished = true;
  }

  /** Refuses any further operation, and waits for every one started to settle */
  async settle(): Promise<void> {
    // Before waiting, so no operation started meanwhile is accepted and then overlaps the discard
    this.close();
    await Promise.allSettled(this.#queue);
  }

  /** @throws What stops the draft being committed: an operation still running, or one whose changes to the stored files couldn't be undone */
  assertCommittable() {
    const count = this.#queue.filter((p) => !p.done).length;
    if (count > 0) {
      throw new Error(`Unfinished operations detected (${count}). Make sure the callback is an async function that awaits every operation it starts.`);
    }
    if (this.#commitBlocker) {
      throw this.#commitBlocker.error;
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

/** The draft a create or update gives its callback, of the version its inventory is at */
class ObjectDraft implements Draft {
  #versionPath: string;
  #contentRoot: string;
  #inventory: OcflObjectInventory;
  #turns: Turns;
  #stagedCount = 0;
  #limit = createLimiter(IMPORT_CONCURRENCY);

  constructor(starting: symbol, versionPath: string, inventory: OcflObjectInventory, turns: Turns) {
    if (starting !== STARTING) {
      throw new TypeError('A draft is made only by an update.');
    }
    this.#versionPath = versionPath;
    this.#contentRoot = path.join(versionPath, inventory.contentDirectory);
    this.#inventory = inventory;
    this.#turns = turns;
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
        this.#turns.blockCommit(error);
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
      this.#turns.blockCommit(error);
      throw error;
    }
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
    this.#turns.assertOpen();
    const checked = checkedContent(data);
    // Copied now: the caller may change their buffer before this write's turn
    const content = checked instanceof Uint8Array ? new Uint8Array(checked) : checked;
    return this.#turns.run(async () => {
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
  async #prepareImport(source: string, options: ImportOptions | undefined): Promise<() => Promise<void>> {
    const files = await listImportFiles(source, importOptions(options));
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
  async import(source: string, options?: ImportOptions): Promise<void> {
    return this.#turns.run(() => this.#prepareImport(source, options));
  }

  async copy(source: string, target: string, options?: MergeOptions): Promise<void> {
    return this.#operate(async () => {
      const merge = mergeOption(options, 'draft.copy');
      const plan = this.#inventory._planCopy(fileLogicalPath(source), fileLogicalPath(target), merge);
      await this.#applyRelist(plan);
    });
  }

  // Content this version stored moves with its path; earlier versions' content stays where the manifest has it
  async rename(source: string, target: string, options?: MergeOptions): Promise<void> {
    return this.#operate(async () => {
      const merge = mergeOption(options, 'draft.rename');
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

  async files(): Promise<ReadonlyMap<string, DraftFile>> {
    return this.#operate(async () => {
      const inventory = this.#inventory;
      return new Map(Array.from(inventory.files(inventory.head), ({ logicalPath, digest }) => [logicalPath, Object.freeze({ path: logicalPath, digest })]));
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

  /** `Turns.run` for an operation with nothing to prepare */
  async #operate<T>(op: () => Promise<T>): Promise<T> {
    return this.#turns.run(async () => op);
  }

  /** Runs `task` within the draft's limit on files read at once, unless the update's signal is aborted by its turn */
  #limited<T>(task: () => Promise<T>): Promise<T> {
    return this.#limit(async () => {
      this.#turns.throwIfAborted();
      return task();
    });
  }
}

/**
 * Runs `change` on a draft of the version `inventory` is at, then commits it, or discards it if `change` throws.
 * A failure before the commit point discards everything the draft made and releases the object's lock, as `ObjectWrite`'s commit and discard describe.
 * @param inventory - Already at its new version
 * @returns The committed inventory, or `undefined` if the draft ended the same as the previous version
 */
async function commitDraft(
  place: ObjectPlace,
  inventory: OcflObjectInventory,
  details: VersionDetails,
  change: (draft: Draft) => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<OcflObjectInventory | undefined> {
  signal?.throwIfAborted();
  const write = await startWrite(place, inventory);
  const turns = new Turns(signal);
  const discard = async (failure?: { error: unknown }) => {
    await turns.settle();
    await write.discard(failure);
  };
  try {
    await change(new ObjectDraft(STARTING, write.versionPath, inventory, turns));
  } catch (error) {
    // Decided as the callback settles, not after the discard, which a late abort mustn't turn into a cancellation
    const cancelled = signal?.aborted ? { reason: signal.reason } : undefined;
    await discard({ error });
    throw cancelled ? cancelled.reason : error;
  }
  turns.close();
  try {
    signal?.throwIfAborted();
    turns.assertCommittable();
  } catch (error) {
    await discard({ error });
    throw error;
  }
  if (!inventory._isChanged) {
    await discard();
    return;
  }
  // assertCommittable proved every operation settled, so the commit's own discard on failure overlaps none
  return write.commit(details);
}

export {
  type CreateOptions,
  commitDraft,
  type Draft,
  type DraftFile,
  type ImportOptions,
  type MergeOptions,
  type UpdateOptions,
  type User,
  type VersionDetails,
  type WriteContent,
  writeOptions,
};
