/** Models a set of ocfl object modifying operations as a transaction that is as close as atomic as possible */
import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import * as Hashing from './digest.ts';
import { OcflError } from './error.ts';
import { type ContentRelease, OcflObjectInventory, type OcflObjectInventoryMut } from './inventory.ts';
import type { OcflObject } from './object.ts';
import * as store from './store.ts';
import type { Digests, WriteFileData } from './types.ts';
import { createLimiter, isAlreadyExists } from './utils.ts';

const { INVENTORY_NAME } = OcflConstants;

function invalidLogicalPath(logicalPath: string) {
  return new OcflError('INVALID_LOGICAL_PATH', `Logical path "${logicalPath}" must be a relative path without \`..\``);
}

// Backslash counts as a separator because path.normalize treats it as one on Windows
function checkLogicalPath(logicalPath: string) {
  if (logicalPath.startsWith('/') || path.isAbsolute(logicalPath) || logicalPath.split(/[/\\]/).includes('..')) {
    throw invalidLogicalPath(logicalPath);
  }
}

export interface CommitOptions {
  /** Freeform text used to record the rationale for creating the current version */
  message?: string | undefined;
  /** Identify the user or agent that created the current Version */
  user?:
    | {
        /** Any readable name of the user, e.g., a proper name, user ID, agent ID. */
        name: string;
        /** A URI: either a mailto URI [RFC6068] with the e-mail address of the user or a URL to a personal identifier, e.g., an ORCID iD. */
        address?: string;
      }
    | undefined;
}

/** A file or directory to import, and where it goes in the object */
export interface ImportSource {
  /** A path to a file or directory in the local filesystem */
  source: string;
  /** The logical path the source becomes. Without one, a directory's contents go at the object root and a file keeps its own name there. */
  target?: string | undefined;
}

/** Files imports read or copy at once, across all the imports in a transaction */
const IMPORT_CONCURRENCY = 10;

interface ImportFile {
  source: string;
  logicalPath: string;
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
  const normalised = path.posix.normalize(target).replace(/\/$/, '');
  if (normalised === '.') {
    throw new OcflError('INVALID_LOGICAL_PATH', "An import target can't be empty; leave it out to import a directory's contents at the object root");
  }
  return normalised;
}

/** @throws {@link OcflError} `FILE_EXISTS` if two files have one logical path, or one is inside another */
function checkImportConflicts(files: ImportFile[]) {
  const logicalPaths = new Set<string>();
  for (const { logicalPath } of files) {
    if (logicalPaths.has(logicalPath)) {
      throw new OcflError('FILE_EXISTS', `More than one source imports to "${logicalPath}"`);
    }
    logicalPaths.add(logicalPath);
  }
  for (const logicalPath of logicalPaths) {
    const segments = logicalPath.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (logicalPaths.has(parent)) {
        throw new OcflError('FILE_EXISTS', `"${parent}" is imported both as a file and as a directory`);
      }
    }
  }
}

function unsupportedFileType(filePath: string) {
  return new OcflError('UNSUPPORTED_FILE_TYPE', `"${filePath}" is not a regular file or directory`);
}

type TrackedPromise<T> = Promise<T> & { done?: boolean };

type Hashes = [digest: string, fixity: Digests];

/** Split the digests into the content digest and the remaining fixity digests */
function splitDigests(digests: Digests, algorithm: string): Hashes {
  const { [algorithm]: digest, ...fixity } = digests;
  if (!digest) {
    throw new Error(`Digest "${algorithm}" was not calculated.`);
  }
  return [digest, fixity];
}

/**
 * A Transaction represent an atomic update on an OCFL Object.
 * When a transaction is commited, all changes are saved as a new version.
 *
 * Operations called concurrently, such as with `Promise.all`, give the same result as awaiting
 * them one after another in the order they were called. A stream from
 * {@link OcflObjectTransaction.createWritable | createWritable()} takes its place in that order
 * once its queued writes finish and it closes, and while open it doesn't hold up other operations. A failed operation
 * rejects its own promise and leaves nothing behind; later operations carry on. An operation
 * waits for all the earlier ones, so one whose input never ends holds up those called after it.
 * If a failed operation's changes to the stored files can't be undone, the transaction can't commit.
 */
class OcflObjectTransaction {
  #versionPath: string;
  #contentRoot: string;
  #object: OcflObject;
  #inventory: OcflObjectInventoryMut;
  #workspace: string | undefined;
  #rootExisted: boolean;
  #createdNamaste: string | undefined;
  #rootInventoryStaged = false;
  #rootInventoryReplaced = false;
  #previousRootInventory: Uint8Array | undefined;
  #queue: TrackedPromise<unknown>[] = [];
  #lastTurn: Promise<unknown> = Promise.resolve();
  #stagedCount = 0;
  #writers = new Set<WritableStreamDefaultWriter>();
  #committed = false;
  #commitBlocker: Error | undefined;
  #limit = createLimiter(IMPORT_CONCURRENCY);

  private constructor(
    ocflObject: OcflObject,
    inventory: OcflObjectInventoryMut,
    versionPath: string,
    workspace: string | undefined,
    rootExisted: boolean,
    createdNamaste: string | undefined,
  ) {
    this.#versionPath = versionPath;
    this.#contentRoot = path.join(versionPath, inventory.contentDirectory);
    this.#object = ocflObject;
    this.#inventory = inventory;
    this.#workspace = workspace;
    this.#rootExisted = rootExisted;
    this.#createdNamaste = createdNamaste;
  }

  /**
   * Create a new transaction instance.
   * @internal
   */
  static async create(ocflObject: OcflObject, inventory: OcflObjectInventoryMut, workspacePath: string) {
    const rootExisted = await fs.promises.stat(ocflObject.root).then(
      () => true,
      () => false,
    );
    const inPlace = workspacePath === ocflObject.root;
    const createdNamaste = inPlace ? await ocflObject._ensureNamaste() : undefined;
    const versionPath = path.join(workspacePath, inventory.head);
    await fs.promises.mkdir(workspacePath, { recursive: true });
    try {
      // Exclusive, so of any overlapping updates only one reserves the version
      await fs.promises.mkdir(versionPath);
    } catch (error) {
      throw isAlreadyExists(error)
        ? new OcflError(
            'UPDATE_IN_PROGRESS',
            'Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt',
          )
        : error;
    }
    return new OcflObjectTransaction(ocflObject, inventory, versionPath, inPlace ? undefined : workspacePath, rootExisted, createdNamaste);
  }

  #getRealPath(logicalPath: string) {
    checkLogicalPath(logicalPath);
    const root = path.resolve(this.#contentRoot);
    const resolved = path.resolve(root, logicalPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw invalidLogicalPath(logicalPath);
    }
    return path.join(this.#contentRoot, path.normalize(logicalPath));
  }

  /**
   * Discard all the changes made in this transaction,
   */
  async rollback(): Promise<void> {
    if (!this.#committed) {
      // An unclosed writer's `closed` never settles, so abort it first
      await Promise.allSettled([...this.#writers].map((w) => w.abort()));
      await Promise.allSettled(this.#queue);
      await this.#undo();
      this.#committed = true;
    }
  }

  /**
   * Commit all the changes made in this transaction to the actual OCFL Object.
   * @param options - Commit options. message and user will be included in the version entry of the inventory.json
   */
  async commit(options?: CommitOptions): Promise<void> {
    if (!this.#committed) {
      const count = this.#queue.filter((p) => !p.done).length;
      if (count > 0) {
        await this.rollback();
        throw new Error(
          `Unfinished operations detected (${count}). Make sure that updater callback is async function and there are no floating promises inside.`,
        );
      }
      if (this.#commitBlocker) {
        await this.rollback();
        throw this.#commitBlocker;
      }
      // if there is no changes, abort commit
      if (!this.#inventory.isChanged) {
        return await this.rollback();
      }
      try {
        await this.#commit(options);
      } catch (error) {
        await this.rollback();
        throw error;
      }
      const committed = new OcflObjectInventory(this.#inventory.toJSON());
      committed._digest = this.#inventory._digest;
      this.#object._setInventory(committed);
      this.#committed = true;
      await this.#removeWorkspaceIfEmpty();
    }
  }

  /** Remove everything this transaction created, restoring the root inventory if it was replaced */
  async #undo() {
    const root = this.#object.root;
    const rootInv = this.#rootInventoryPaths;
    if (this.#rootInventoryReplaced) {
      if (this.#previousRootInventory) {
        await store.writeFile(rootInv.inventoryTmp, this.#previousRootInventory);
        await store.move(rootInv.inventoryTmp, rootInv.inventory);
      } else {
        await fs.promises.rm(rootInv.inventory, { recursive: true, force: true });
      }
    }
    if (this.#rootInventoryStaged) {
      await fs.promises.rm(rootInv.inventoryTmp, { recursive: true, force: true });
      await fs.promises.rm(rootInv.digestTmp, { recursive: true, force: true });
    }
    await fs.promises.rm(this.#versionPath, { recursive: true, force: true });
    if (this.#createdNamaste) {
      await fs.promises.rm(this.#createdNamaste, { recursive: true, force: true });
    }
    if (!this.#rootExisted) {
      await this.#tidy(root);
    }
    await this.#removeWorkspaceIfEmpty();
  }

  async #removeWorkspaceIfEmpty() {
    if (this.#workspace) {
      await this.#tidy(this.#workspace);
    }
  }

  /** A leftover empty directory is harmless, so failing to remove one must not mask the update's outcome */
  async #tidy(dirPath: string) {
    await store.removeIfEmpty(dirPath).catch(() => {});
  }

  get #rootInventoryPaths() {
    const inventory = path.join(this.#object.root, INVENTORY_NAME);
    const digest = `${inventory}.${this.#inventory.digestAlgorithm}`;
    return { inventory, digest, inventoryTmp: `${inventory}.tmp`, digestTmp: `${digest}.tmp` };
  }

  async #commit(options: CommitOptions = {}) {
    const inventory = this.#inventory;
    const digestAlgorithm = inventory.digestAlgorithm;
    // set commit info
    inventory.created = new Date().toISOString();
    if (options.message) {
      inventory.message = options.message;
    }
    if (options.user) {
      inventory.user = options.user;
    }

    const objectVersionPath = path.join(this.#object.root, inventory.head);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json */
    let invPath = path.join(this.#versionPath, INVENTORY_NAME);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json.sha512 */
    let invDigestPath = `${invPath}.${digestAlgorithm}`;

    const inventoryContent = inventory.toString();
    inventory._digest = await Hashing.digest(digestAlgorithm, inventoryContent);
    const digest = `${inventory._digest} ${INVENTORY_NAME}`;

    // write inventory.json to workspace
    await store.writeFile(invPath, inventoryContent);
    await store.writeFile(invDigestPath, digest);
    if (this.#workspace) {
      this.#createdNamaste = await this.#object._ensureNamaste();
      await store.move(this.#versionPath, objectVersionPath);
      this.#versionPath = objectVersionPath;
    }
    // replace root inventory
    const rootInv = this.#rootInventoryPaths;
    /* eg: /data/aa/bb/cc/object-1/v1/inventory.json */
    invPath = path.join(objectVersionPath, INVENTORY_NAME);
    invDigestPath = `${invPath}.${digestAlgorithm}`;
    this.#rootInventoryStaged = true;
    await store.copyFile(invPath, rootInv.inventoryTmp);
    await store.copyFile(invDigestPath, rootInv.digestTmp);
    if (inventory.versionNumber.previous()) {
      this.#previousRootInventory = await fs.promises.readFile(rootInv.inventory);
    }
    await store.move(rootInv.inventoryTmp, rootInv.inventory);
    this.#rootInventoryReplaced = true;
    await store.move(rootInv.digestTmp, rootInv.digest);
  }

  get #digestAlgorithms() {
    return [this.#inventory.digestAlgorithm, ...(this.#object.fixityAlgorithms || [])];
  }

  /** Content waits here, outside the content directory, until its digest decides whether it's kept */
  #stagingPath() {
    return path.join(this.#versionPath, `.staged-${++this.#stagedCount}`);
  }

  async #removeStagedOnFailure<T>(staging: string, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Must run in the operation's turn.
   * @param stage - Fills `staging`, if it isn't already, once the content is known to be needed
   */
  async #addContent(logicalPath: string, [digest, fixity]: Hashes, staging: string, stage?: () => Promise<void>) {
    const inventory = this.#inventory;
    const releases = inventory.getDigest(logicalPath) === digest ? [] : inventory._contentReleases([logicalPath]);
    const isNew = !inventory.getContentPath(digest);
    await this.#removeStagedOnFailure(staging, async () => {
      const realPath = isNew ? this.#getRealPath(logicalPath) : undefined;
      if (isNew) {
        await stage?.();
      }
      await this.#applyContentReleases(releases, realPath, async () => {
        if (realPath) {
          await store.move(staging, realPath);
        } else if (!stage) {
          await fs.promises.rm(staging, { recursive: true, force: true });
        }
      });
    });
    inventory.add(logicalPath, digest, fixity);
  }

  /**
   * Make releases' changes to the stored files around `place`, undoing every move if a move or `place` fails.
   * @param placedAt - The file `place` fills, if it stores any content
   */
  async #applyContentReleases(releases: ContentRelease[], placedAt?: string, place?: () => Promise<void>) {
    const files = releases.map(({ from, to }) => ({
      from: this.#contentFilePath(from),
      to: to === undefined ? undefined : this.#contentFilePath(to),
    }));
    const moved: { from: string; to: string }[] = [];
    try {
      for (const { from, to } of files) {
        if (to !== undefined) {
          await store.move(from, to);
          moved.push({ from, to });
        }
      }
      await place?.();
    } catch (error) {
      await this.#blockCommitOnFailure(async () => {
        for (const { from, to } of moved.reverse()) {
          await store.move(to, from);
          await this.#pruneEmptyDirectories(path.dirname(to));
        }
      }).catch(() => {});
      throw error;
    }
    const vacated = files.filter(({ from }) => from !== placedAt);
    await this.#blockCommitOnFailure(async () => {
      for (const { from, to } of vacated) {
        if (to === undefined) {
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
      this.#commitBlocker ??= new Error('Update cannot be committed: a change to its files failed and could not be undone', { cause: error });
      throw error;
    }
  }

  #contentFilePath(contentPath: string) {
    return path.join(path.dirname(this.#versionPath), contentPath);
  }

  /** A version shouldn't contain empty directories, so remove any at or above `start`, up to and including the content directory */
  async #pruneEmptyDirectories(start: string) {
    for (let dir = start; dir !== this.#versionPath; dir = path.dirname(dir)) {
      await this.#tidy(dir);
    }
  }

  /**
   * Create a writable stream
   */
  async createWritable(logicalPath: string, options?: unknown): Promise<WritableStream> {
    if (this.#committed) {
      throw new Error('Transaction already commited');
    }
    const digestAlgo = this.#inventory.digestAlgorithm;
    const hs = Hashing.createStream(this.#digestAlgorithms);
    checkLogicalPath(logicalPath);
    const staging = this.#stagingPath();
    const writer = (await store.createWritable(staging, options)).getWriter();
    const ws = new WritableStream({
      write(chunk) {
        hs.update(chunk);
        return writer.write(chunk);
      },
      close: () =>
        this.#inTurn(async () => {
          await writer.close();
          const hashes = splitDigests(hs.digest(), digestAlgo);
          return () => this.#addContent(logicalPath, hashes, staging);
        }),
      abort: (reason) => writer.abort(reason),
    });
    this.#writers.add(writer);
    this.#track(writer.closed.finally(() => this.#writers.delete(writer)).catch(() => fs.promises.rm(staging, { recursive: true, force: true })));

    return ws;
  }

  /**
   * Write data to a file at `logicalPath`
   * @param logicalPath - A path relative to the object content directory
   * @param data - Data to be written to the file
   * @param options - The same options as https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback
   */
  async write(logicalPath: string, data: WriteFileData, options?: object | string): Promise<void> {
    return this.#inTurn(async () => {
      checkLogicalPath(logicalPath);
      const digestAlgo = this.#inventory.digestAlgorithm;
      const digestAlgos = this.#digestAlgorithms;
      const staging = this.#stagingPath();
      if (typeof data === 'string' || ArrayBuffer.isView(data)) {
        const content =
          ArrayBuffer.isView(data) && !(data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Uint32Array)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data;
        const hashes = splitDigests(await Hashing.digest(digestAlgos, content as string | Uint8Array), digestAlgo);
        return () => this.#addContent(logicalPath, hashes, staging, () => store.writeFile(staging, content, options));
      }
      if (data instanceof ReadableStream) {
        const hs = Hashing.createStreamThrough(digestAlgos);
        await this.#removeStagedOnFailure(staging, () => store.writeFile(staging, data.pipeThrough(hs), options));
        const hashes = splitDigests(hs.digest(), digestAlgo);
        return () => this.#addContent(logicalPath, hashes, staging);
      }
      throw new TypeError(`Unsupported data type: ${Object.prototype.toString.call(data)}`);
    });
  }

  /** The source was hashed before the copy, so the copy is hashed too, to check they're the same bytes */
  async #stageImportedFile(source: string, staging: string, digest: string) {
    await store.copyFile(source, staging);
    if ((await Hashing.digest(this.#inventory.digestAlgorithm, store.createReadable(staging))) !== digest) {
      throw new OcflError('SOURCE_CHANGED', `"${source}" changed while it was being imported`);
    }
  }

  /** @returns the step that adds the prepared files, which must run in the import's turn */
  async #prepareImport(sources: ImportSource[]): Promise<() => Promise<void>> {
    const files = (await Promise.all(sources.map(({ source, target }) => listImportFiles(source, target)))).flat();
    checkImportConflicts(files);
    const algorithms = this.#digestAlgorithms;
    const hashed = await Promise.all(
      files.map((file) =>
        this.#limit(() => Hashing.digest(algorithms, store.createReadable(file.source))).then(
          (digests) => ({ ...file, digests }),
          (error: unknown) => ({ ...file, error }),
        ),
      ),
    );
    return async () => {
      const errors: unknown[] = [];
      for (const file of hashed) {
        if (!('digests' in file)) {
          errors.push(file.error);
          continue;
        }
        const hashes = splitDigests(file.digests, this.#inventory.digestAlgorithm);
        const staging = this.#stagingPath();
        await this.#addContent(file.logicalPath, hashes, staging, () => this.#limit(() => this.#stageImportedFile(file.source, staging, hashes[0]))).catch(
          (error) => errors.push(error),
        );
      }
      if (errors.length) {
        throw new AggregateError(errors, `Cannot import ${sources.map(({ source }) => source).join(', ')}`);
      }
    };
  }

  /**
   * Copy a file or directory from the local filesystem into the object, recursively.
   * `t.import('/src/data')` puts the directory's contents at the object root, and
   * `t.import('/src/data', 'data')` puts them under `data/`. A file without a target keeps its own name.
   * Everything under a directory is imported, including hidden files.
   * @param source - A path to a file or directory in the local filesystem
   * @param target - The logical path the source becomes
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `target` is empty or absolute, or contains `..`
   * @throws {@link OcflError} `UNSUPPORTED_FILE_TYPE` if `source` is, or contains, anything other than a regular file or directory, such as a symlink
   * @throws `AggregateError` of each file's error if any file can't be imported, including {@link OcflError} `SOURCE_CHANGED` if a file changed while it was being imported
   */
  async import(source: string, target?: string): Promise<void> {
    return this._importAll([{ source, target }]);
  }

  /**
   * Import several sources as one operation.
   * @internal
   */
  async _importAll(sources: ImportSource[]): Promise<void> {
    return this.#inTurn(() => this.#prepareImport(sources));
  }

  /**
   * Duplicate the logical path `source` as a different logical path `target`, both paths will then point
   * to the same content path and bitstreams. `source` can be a file or a directory.
   * @param source - The logical path to be copied
   * @param target - The target logical path. To replace an existing target, remove it first.
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` doesn't exist
   * @throws {@link OcflError} `FILE_EXISTS` if `target` is an existing file or directory, or is inside an existing file, including when it is `source`
   */
  async copy(source: string, target: string): Promise<void> {
    return this.#transact(async () => {
      checkLogicalPath(target);
      this.#inventory.copy(source, target);
    });
  }

  /**
   * Changes the logical path of existing content. This is similar to move operation in file systems
   * Unless renaming files that are not yet commited, this operation will NOT rename the actual file name referenced by the manifest.
   * `source` can be a file or a directory.
   * @param source - The logical path to be renamed
   * @param target - The target logical path. To replace an existing target, remove it first.
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` doesn't exist
   * @throws {@link OcflError} `FILE_EXISTS` if `target` is an existing file or directory, or is inside an existing file, including when it is `source`
   */
  async rename(source: string, target: string): Promise<void> {
    return this.#transact(async () => {
      checkLogicalPath(source);
      checkLogicalPath(target);
      const plan = this.#inventory._planRename(source, target);
      await this.#applyContentReleases(plan.releases);
      this.#inventory._applyRename(plan);
    });
  }

  /**
   * Makes content from a version earlier than the previous version available in the current version of an OCFL Object.
   */
  async reinstate(logicalPath: string, versionName: string): Promise<number> {
    return this.#transact(async () => this.#inventory.reinstate(logicalPath, versionName));
  }

  /**
   * Remove a file or directory
   * @param logicalPath - A path relative to the object content directory
   */
  async remove(logicalPath: string): Promise<void> {
    return this.#transact(async () => {
      checkLogicalPath(logicalPath);
      const inventory = this.#inventory;
      const plan = inventory._planDelete(logicalPath);
      await this.#applyContentReleases(plan.releases);
      inventory._applyDelete(plan);
    });
  }

  /** `#inTurn` for an operation with nothing to prepare */
  async #transact<T>(op: () => Promise<T>): Promise<T> {
    return this.#inTurn(async () => op);
  }

  /**
   * A function wrapper to provide safe mutating operation that
   * will check if a transaction is already committed and track any unfinished promises.
   * `prepare` starts straight away and may overlap other operations, so it mustn't touch the
   * inventory or content directory. The step it resolves to runs once every operation called
   * earlier has finished.
   */
  async #inTurn<T>(prepare: () => Promise<() => Promise<T>>): Promise<T> {
    if (this.#committed) {
      throw new Error('Transaction already commited');
    }
    const prepared = prepare();
    // A rejection surfaces at this operation's turn, which may come much later
    prepared.catch(() => {});
    const turn = this.#lastTurn.then(async () => (await prepared)());
    this.#lastTurn = turn.catch(() => {});
    return this.#track(turn);
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

export { OcflObjectTransaction };
