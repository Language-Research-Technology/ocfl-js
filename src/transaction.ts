/** Models a set of ocfl object modifying operations as a transaction that is as close as atomic as possible */
import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import * as Hashing from './digest.ts';
import { OcflError } from './error.ts';
import type { ContentRelease, DeletePlan, OcflObjectInventory } from './inventory.ts';
import * as store from './store.ts';
import type { OcflVersion, WriteFileData } from './types.ts';
import {
  createLimiter,
  findNamasteVersion,
  hasErrorCode,
  isAlreadyExists,
  isDirEmpty,
  isNotFound,
  normaliseLogicalPath,
  parentDirectories,
  pathExists,
  relativeWithin,
} from './utils.ts';
import { createError } from './validation.ts';

const { EXTENSIONS_DIR, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T, WORKSPACE_EXTENSION } = OcflConstants;
const MUTABLE_HEAD_INVENTORY = path.join(EXTENSIONS_DIR, '0005-mutable-head', 'head', INVENTORY_NAME);

export interface UpdateTarget {
  /** Absolute path of the object root */
  readonly root: string;
  /** This object's directory in the storage root's workspace */
  readonly workspace: string;
  /** Absolute path of the storage root, where removing empty directories stops */
  readonly storageRoot: string;
  /** Declared when the first commit creates the object */
  readonly ocflVersion: OcflVersion;
}

/** @param objectRoot - Absolute, and inside the storage root at the absolute path `root` */
function updateTarget(root: string, objectRoot: string, ocflVersion: OcflVersion): UpdateTarget {
  return {
    root: objectRoot,
    workspace: path.join(root, EXTENSIONS_DIR, WORKSPACE_EXTENSION, path.relative(root, objectRoot)),
    storageRoot: root,
    ocflVersion,
  };
}

/** @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE`, with `message`, if the object has an active mutable head (extension 0005) */
async function assertNoMutableHead(objectRoot: string, message: string): Promise<void> {
  if (await pathExists(path.join(objectRoot, MUTABLE_HEAD_INVENTORY))) {
    throw new OcflError('MUTABLE_HEAD_ACTIVE', message);
  }
}

/** @returns The path of the declaration file, if this call wrote one */
async function ensureObjectDeclaration(root: string, ocflVersion: OcflVersion): Promise<string | undefined> {
  const declared = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, root);
  if (declared === '') {
    throw createError('E007', root);
  }
  if (declared) {
    return;
  }
  if (!(await isDirEmpty(root))) {
    throw new OcflError('DIRECTORY_NOT_EMPTY', 'Cannot create an OCFL Object in a non-empty directory');
  }
  const declaration = NAMASTE_PREFIX_OBJECT + ocflVersion;
  const filePath = path.join(root, NAMASTE_T + declaration);
  await store.writeFile(filePath, `${declaration}\n`);
  return filePath;
}

function invalidLogicalPath(logicalPath: string) {
  return new OcflError('INVALID_LOGICAL_PATH', `Logical path "${logicalPath}" must be a relative path without \`..\``);
}

// Backslash counts as a separator because path.normalize treats it as one on Windows
function checkLogicalPath(logicalPath: string) {
  if (logicalPath.startsWith('/') || path.isAbsolute(logicalPath) || logicalPath.split(/[/\\]/).includes('..')) {
    throw invalidLogicalPath(logicalPath);
  }
}

/** A file's logical path in the form the inventory lists, so two spellings of one path are the same path */
function fileLogicalPath(logicalPath: string) {
  checkLogicalPath(logicalPath);
  const normalised = normaliseLogicalPath(logicalPath);
  if (normalised === '.') {
    throw new OcflError('INVALID_LOGICAL_PATH', "A file's logical path can't be empty");
  }
  return normalised;
}

function isAsyncIterable(data: unknown): data is AsyncIterable<unknown> {
  return typeof (data as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === 'function';
}

async function* hashedBytes(source: AsyncIterable<unknown>, hash: ReturnType<typeof Hashing.createHasher>) {
  for await (const chunk of source) {
    const bytes = Hashing.toBytes(chunk);
    hash.update(bytes);
    yield bytes;
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
const MAX_RESERVE_ATTEMPTS = 3;

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
    const parent = parentDirectories(logicalPath).find((directory) => logicalPaths.has(directory));
    if (parent !== undefined) {
      throw new OcflError('FILE_EXISTS', `"${parent}" is imported both as a file and as a directory`);
    }
  }
}

function unsupportedFileType(filePath: string) {
  return new OcflError('UNSUPPORTED_FILE_TYPE', `"${filePath}" is not a regular file or directory`);
}

type TrackedPromise<T> = Promise<T> & { done?: boolean };

/**
 * A Transaction represent an atomic update on an OCFL Object.
 * When a transaction is commited, all changes are saved as a new version.
 *
 * Operations called concurrently, such as with `Promise.all`, give the same result as awaiting
 * them one after another in the order they were called. A failed operation
 * rejects its own promise and leaves nothing behind; later operations carry on. An operation
 * waits for all the earlier ones, so one whose input never ends holds up those called after it.
 * If a failed operation's changes to the stored files can't be undone, the commit discards the transaction and throws that operation's error.
 */
class OcflObjectTransaction {
  #versionPath: string;
  #contentRoot: string;
  #target: UpdateTarget;
  #inventory: OcflObjectInventory;
  #rootExisted: boolean;
  #createdNamaste: string | undefined;
  #rootInventoryStaged = false;
  #rootInventoryReplaced = false;
  #previousRootInventory: Uint8Array | undefined;
  #queue: TrackedPromise<unknown>[] = [];
  #lastTurn: Promise<unknown> = Promise.resolve();
  #stagedCount = 0;
  #committed = false;
  #commitBlocker: { error: unknown } | undefined;
  #limit = createLimiter(IMPORT_CONCURRENCY);

  private constructor(target: UpdateTarget, inventory: OcflObjectInventory, versionPath: string, rootExisted: boolean) {
    this.#versionPath = versionPath;
    this.#contentRoot = path.join(versionPath, inventory.contentDirectory);
    this.#target = target;
    this.#inventory = inventory;
    this.#rootExisted = rootExisted;
  }

  /**
   * Create a new transaction instance.
   * @internal
   */
  static async create(target: UpdateTarget, inventory: OcflObjectInventory) {
    const rootExisted = await fs.promises.stat(target.root).then(
      () => true,
      () => false,
    );
    const versionPath = path.join(target.workspace, inventory.head);
    for (let attempt = 1; ; attempt++) {
      await fs.promises.mkdir(target.workspace, { recursive: true });
      try {
        // Exclusive, so of any overlapping updates only one reserves the version
        await fs.promises.mkdir(versionPath);
        break;
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new OcflError(
            'UPDATE_IN_PROGRESS',
            'Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt',
          );
        }
        // Another update's cleanup removed the empty workspace between the two mkdirs
        if (!isNotFound(error) || attempt === MAX_RESERVE_ATTEMPTS) {
          throw error;
        }
      }
    }
    return new OcflObjectTransaction(target, inventory, versionPath, rootExisted);
  }

  #getRealPath(logicalPath: string) {
    checkLogicalPath(logicalPath);
    if (relativeWithin(path.resolve(this.#contentRoot), logicalPath) === undefined) {
      throw invalidLogicalPath(logicalPath);
    }
    return path.join(this.#contentRoot, path.normalize(logicalPath));
  }

  /**
   * Discard all the changes made in this transaction,
   */
  async rollback(): Promise<void> {
    if (!this.#committed) {
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
    await this._commit(options);
  }

  /**
   * @returns The committed inventory, or `undefined` if nothing was committed: there were no changes, or the transaction had already ended
   * @internal
   */
  async _commit(options?: CommitOptions): Promise<OcflObjectInventory | undefined> {
    if (!this.#committed) {
      const count = this.#queue.filter((p) => !p.done).length;
      if (count > 0) {
        await this.rollback();
        throw new Error(`Unfinished operations detected (${count}). Make sure the callback is an async function that awaits every operation it starts.`);
      }
      if (this.#commitBlocker) {
        await this.rollback();
        throw this.#commitBlocker.error;
      }
      // if there is no changes, abort commit
      if (!this.#inventory._isChanged) {
        await this.rollback();
        return;
      }
      try {
        await this.#commit(options);
      } catch (error) {
        await this.rollback();
        throw error;
      }
      this.#committed = true;
      await this.#removeEmptyAncestors(this.#target.workspace);
      return this.#inventory;
    }
  }

  /** Remove everything this transaction created, restoring the root inventory if it was replaced */
  async #undo() {
    const root = this.#target.root;
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
      await this.#removeEmptyAncestors(root);
    }
    await this.#removeEmptyAncestors(this.#target.workspace);
  }

  /**
   * Remove `dirPath` and the parents it leaves empty, below `stopAt`.
   * A leftover empty directory is harmless, so failing to remove one must not mask the update's outcome.
   */
  async #removeEmptyAncestors(dirPath: string, stopAt = this.#target.storageRoot) {
    await store.removeEmptyAncestors(dirPath, stopAt).catch(() => {});
  }

  get #rootInventoryPaths() {
    const inventory = path.join(this.#target.root, INVENTORY_NAME);
    const digest = `${inventory}.${this.#inventory.digestAlgorithm}`;
    return { inventory, digest, inventoryTmp: `${inventory}.tmp`, digestTmp: `${digest}.tmp` };
  }

  async #commit(options: CommitOptions = {}) {
    const inventory = this.#inventory;
    const digestAlgorithm = inventory.digestAlgorithm;
    inventory._stamp(new Date().toISOString(), options.message, options.user);

    const objectVersionPath = path.join(this.#target.root, inventory.head);
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
    this.#createdNamaste = await ensureObjectDeclaration(this.#target.root, this.#target.ocflVersion);
    try {
      await store.move(this.#versionPath, objectVersionPath);
    } catch (error) {
      throw hasErrorCode(error, 'EXDEV')
        ? new OcflError('CROSS_FILESYSTEM_MOVE', `Cannot move the new version into "${this.#target.root}": it is on a different filesystem from the workspace.`)
        : error;
    }
    this.#versionPath = objectVersionPath;
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
          await store.move(staging, realPath);
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
          await store.move(from, to);
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
          await store.move(to, from);
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
    await this.#removeEmptyAncestors(start, this.#versionPath);
  }

  /**
   * Write data to a file at `logicalPath`
   * @param logicalPath - A path relative to the object content directory, stored in its normalised form: `./a//b` is `a/b`
   * @param data - The file's content. A string, or a string chunk, is written as UTF-8; decode base64 or hex
   * first, e.g. `Buffer.from(text, 'base64')`.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `logicalPath` is empty or absolute, or contains `..`
   * @throws {@link OcflError} `FILE_EXISTS` if `logicalPath` is an existing directory, or is inside an existing file. An existing file is replaced.
   */
  async write(logicalPath: string, data: WriteFileData): Promise<void> {
    return this.#inTurn(async () => {
      const target = fileLogicalPath(logicalPath);
      const digestAlgo = this.#inventory.digestAlgorithm;
      const staging = this.#stagingPath();
      const chunks = data instanceof Blob ? data.stream() : data;
      if (isAsyncIterable(chunks)) {
        const hash = Hashing.createHasher(digestAlgo);
        await this.#removeStagedOnFailure(staging, () => store.writeFile(staging, hashedBytes(chunks, hash)));
        const digest = hash.digest();
        return () => this.#addContent(target, digest, staging);
      }
      const content = Hashing.toBytes(data);
      const digest = await Hashing.digest(digestAlgo, content);
      return () => this.#addContent(target, digest, staging, () => store.writeFile(staging, content));
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
    const algorithm = this.#inventory.digestAlgorithm;
    const hashed = await Promise.all(
      files.map((file) =>
        this.#limit(() => Hashing.digest(algorithm, store.createReadable(file.source))).then(
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
          await this.#limit(() => this.#stageImportedFile(source, staging, digest));
        }
      }
    } catch (error) {
      await Promise.all(Array.from(staged.values(), (staging) => fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})));
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
      !contentPath.startsWith(`${inventory.head}/`) || (inventory.state[digest] ?? []).some((logicalPath) => (imported.get(logicalPath) ?? digest) === digest)
    );
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
   * @throws {@link OcflError} `FILE_EXISTS` if a file would be an existing directory, or inside an existing file, importing nothing. An existing file is replaced.
   * @throws {@link OcflError} `SOURCE_CHANGED` if a file changed while it was being imported
   * @throws The error of the first file that can't be imported, as it is. A failed import adds nothing, unless a copied file can't be put in place, which fails the commit.
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
   * @param target - The target logical path. A file already there is replaced; the same path as `source` does nothing.
   * @param options - With `merge`, a directory goes file by file into a `target` that has files: files at the same path are replaced and the rest stay
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` doesn't exist
   * @throws {@link OcflError} `FILE_EXISTS` if `source` is a directory and `target` already has files, unless `merge` is set, or if a path would become both a file and a directory
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`
   */
  async copy(source: string, target: string, options?: { merge: boolean }): Promise<void> {
    return this.#transact(async () => {
      const plan = this.#inventory._planCopy(fileLogicalPath(source), fileLogicalPath(target), options?.merge === true);
      await this.#applyContentReleases(plan.releases);
      this.#inventory._applyRelist(plan);
    });
  }

  /**
   * Changes the logical path of existing content. This is similar to move operation in file systems
   * Unless renaming files that are not yet commited, this operation will NOT rename the actual file name referenced by the manifest.
   * `source` can be a file or a directory.
   * @param source - The logical path to be renamed
   * @param target - The target logical path. A file already there is replaced; the same path as `source` does nothing.
   * @param options - With `merge`, a directory goes file by file into a `target` that has files: files at the same path are replaced and the rest stay
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `source` doesn't exist
   * @throws {@link OcflError} `FILE_EXISTS` if `source` is a directory and `target` already has files, unless `merge` is set, or if a path would become both a file and a directory
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if a path is empty or leaves the object, or `target` is inside `source`
   */
  async rename(source: string, target: string, options?: { merge: boolean }): Promise<void> {
    return this.#transact(async () => {
      const plan = this.#inventory._planRename(fileLogicalPath(source), fileLogicalPath(target), options?.merge === true);
      await this.#applyContentReleases(plan.releases);
      this.#inventory._applyRelist(plan);
    });
  }

  /**
   * Put a file, or every file below a directory, back as it was in an earlier version, at the same logical path.
   * Files now at the same paths are replaced; other files below a directory stay.
   * @param logicalPath - The logical path of a file or directory in `version`
   * @param version - The number of an existing version, which can be the latest
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the version doesn't exist or has nothing at `logicalPath`
   * @throws {@link OcflError} `FILE_EXISTS` if a path would become both a file and a directory
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `logicalPath` is empty or leaves the object
   */
  async reinstate(logicalPath: string, version: number): Promise<void> {
    return this.#transact(async () => {
      const plan = this.#inventory._planReinstate(fileLogicalPath(logicalPath), version);
      await this.#applyContentReleases(plan.releases);
      this.#inventory._applyRelist(plan);
    });
  }

  /**
   * Remove a file, or every file below a directory
   * @param logicalPath - A path relative to the object content directory
   * @throws {@link OcflError} `FILE_NOT_FOUND` if nothing is at `logicalPath`
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `logicalPath` is empty or leaves the object
   */
  async remove(logicalPath: string): Promise<void> {
    return this.#transact(async () => {
      const inventory = this.#inventory;
      const plan = inventory._planDelete(fileLogicalPath(logicalPath));
      if (plan.paths.length === 0) {
        throw new OcflError('FILE_NOT_FOUND', `Logical path "${logicalPath}" does not exist in object [${inventory.id}]`);
      }
      await this.#applyDelete(plan);
    });
  }

  /** Remove every file */
  async clear(): Promise<void> {
    return this.#transact(() => this.#applyDelete(this.#inventory._planClear()));
  }

  async #applyDelete(plan: DeletePlan) {
    await this.#applyContentReleases(plan.releases);
    this.#inventory._applyDelete(plan);
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

export { assertNoMutableHead, isAsyncIterable, OcflObjectTransaction, updateTarget };
