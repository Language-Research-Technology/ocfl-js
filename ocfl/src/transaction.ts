/** Models a set of ocfl object modifying operations as a transaction that is as close as atomic as possible */
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflDigest } from './digest.ts';
import { OcflError } from './error.ts';
import type { OcflObjectInventoryMut } from './inventory.ts';
import type { OcflObject } from './object.ts';
import type { OcflStore, WriteFileData } from './store.ts';
import { isAlreadyExists, isNotFound, parallelize } from './utils.ts';

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
  /** If true, force to commit. Use it after a purge. */
  force?: boolean | undefined;
}

export interface RemoveOptions {
  /** If true, completely remove the content from all versions */
  purge?: boolean | undefined;
}

type TrackedPromise<T> = Promise<T> & { done?: boolean };

/** Split the digests into the content digest and the remaining fixity digests */
function splitDigests(digests: { [algorithm: string]: string }, algorithm: string): [string, { [algorithm: string]: string }] {
  const { [algorithm]: digest, ...fixity } = digests;
  if (!digest) {
    throw new Error(`Digest "${algorithm}" was not calculated.`);
  }
  return [digest, fixity];
}

/**
 * A Transaction represent an atomic update on an OCFL Object.
 * When a transaction is commited, all changes are saved as a new version.
 * This is a wrapper class to hide all the storage specific implementation.
 */
class OcflObjectTransaction {
  /**
   * Discard all the changes made in this transaction,
   * @abstract
   */
  async rollback(): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Commit all the changes made in this transaction to the actual OCFL Object.
   * @abstract
   * @param options - Commit options. message and user will be included in the version entry of the inventory.json
   */
  async commit(_options?: CommitOptions): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Completely remove a file path and corresponding content from all versions of an OCFL Object.
   * This is a special case that is not supported as part of regular OCFL versioning operations.
   */
  async purge(logicalPath: string): Promise<void> {
    return await this.remove(logicalPath, { purge: true });
  }

  /**
   * Write data to a file at `logicalPath`
   * @abstract
   * @param logicalPath - A path relative to the object content directory
   * @param data - Data to be written to the file
   * @param options - The same options as https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback
   */
  async write(_logicalPath: string, _data: WriteFileData, _options?: object | string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Import content by recursively copying a file or directory from local file system to the
   * OCFL Object content. For example, `object.import('/home/john/data/b','data/b')` will
   * copy `/home/john/data/b` from the local filesystem to the content `data/b` in the OFCL Object.
   * Set target to empty string ('') to copy a directory content to the object's content root.
   * If target is not specified, the base name of the source will be used.
   * For examples:
   * To copy '/src/data' directory as 'data' use import('/src/data', 'data').
   * To copy all files inside '/src/data' directory to the logical root, use import('/src/data', '').
   * @abstract
   * @param source - A path to a file or directory in the local filesystem to be copied
   * @param target - A logical path in the OCFL Object content.
   */
  async import(_source: string, _target?: string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Duplicate the logical path `source` as a different logical path `target`, both paths will then point
   * to the same content path and bitstreams.
   * @abstract
   * @param source - The logical path to be copied
   * @param target - The target logical path
   */
  async copy(_source: string, _target: string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Changes the logical path of existing content. This is similar to move operation in file systems
   * Unless renaming files that are not yet commited, this operation will NOT rename the actual file name referenced by the manifest.
   * @abstract
   */
  async rename(_source: string, _target: string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Alias of {@link OcflObjectTransaction.rename}
   */
  async move(source: string, target: string): Promise<void> {
    return this.rename(source, target);
  }

  /**
   * Remove a file or directory
   * @abstract
   * @param logicalPath - A path relative to the object content directory
   */
  async remove(_logicalPath: string, _options?: RemoveOptions): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Remove a file or directory. Alias of {@link OcflObjectTransaction.remove}
   * @param logicalPath - A path relative to the object content directory
   */
  async delete(logicalPath: string, options?: RemoveOptions): Promise<void> {
    return this.remove(logicalPath, options);
  }

  /**
   * Makes content from a version earlier than the previous version available in the current version of an OCFL Object.
   * @abstract
   */
  async reinstate(_logicalPath: string, _versionName: string): Promise<number> {
    throw new Error('Not Implemented');
  }

  /**
   * Create a writable stream
   * @abstract
   */
  async createWritable(_logicalPath: string, _options?: unknown): Promise<WritableStream> {
    throw new Error('Not Implemented');
  }
}

/**
 * Base class for any transaction implementation on different storage backend
 */
class OcflObjectTransactionImpl extends OcflObjectTransaction {
  _versionPath: string;
  _contentRoot: string;
  _object: OcflObject;
  _store: OcflStore;
  _inventory: OcflObjectInventoryMut;
  _workspace: string | undefined;
  _rootExisted: boolean;
  _createdNamaste: string | undefined;
  _rootInventoryStaged = false;
  _rootInventoryReplaced = false;
  _previousRootInventory: Uint8Array | undefined;
  _queue: TrackedPromise<unknown>[] = [];
  _writers = new Set<WritableStreamDefaultWriter>();
  _committed = false;

  constructor(
    ocflObject: OcflObject,
    ocflStore: OcflStore,
    inventory: OcflObjectInventoryMut,
    versionPath: string,
    workspace: string | undefined,
    rootExisted: boolean,
    createdNamaste: string | undefined,
  ) {
    super();
    this._versionPath = versionPath;
    this._contentRoot = path.join(versionPath, inventory.contentDirectory);
    this._object = ocflObject;
    this._store = ocflStore;
    this._inventory = inventory;
    this._workspace = workspace;
    this._rootExisted = rootExisted;
    this._createdNamaste = createdNamaste;
  }

  /**
   * Create a new transaction instance.
   */
  static async create(ocflObject: OcflObject, ocflStore: OcflStore, inventory: OcflObjectInventoryMut, workspacePath: string) {
    const rootExisted = await ocflStore.exists(ocflObject.root);
    const inPlace = workspacePath === ocflObject.root;
    const createdNamaste = inPlace ? await ocflObject._ensureNamaste() : undefined;
    const versionPath = path.join(workspacePath, inventory.head);
    const updateInProgress = new OcflError(
      'UPDATE_IN_PROGRESS',
      'Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt',
    );
    // A backend without real directories can't fail the exclusive mkdir below
    if (await ocflStore.exists(versionPath)) {
      throw updateInProgress;
    }
    await ocflStore.mkdir(workspacePath);
    try {
      // Exclusive, so of any overlapping updates only one reserves the version
      await ocflStore.mkdir(versionPath, { recursive: false });
    } catch (error) {
      throw isAlreadyExists(error) ? updateInProgress : error;
    }
    return new OcflObjectTransactionImpl(ocflObject, ocflStore, inventory, versionPath, inPlace ? undefined : workspacePath, rootExisted, createdNamaste);
  }

  _getRealPath(logicalPath: string) {
    checkLogicalPath(logicalPath);
    const root = path.resolve(this._contentRoot);
    const resolved = path.resolve(root, logicalPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw invalidLogicalPath(logicalPath);
    }
    return path.join(this._contentRoot, path.normalize(logicalPath));
  }

  async rollback() {
    if (!this._committed) {
      // An unclosed writer's `closed` never settles, so abort it first
      await Promise.allSettled([...this._writers].map((w) => w.abort()));
      await Promise.allSettled(this._queue);
      await this._undo();
      this._committed = true;
    }
  }

  async commit(options?: CommitOptions) {
    if (!this._committed) {
      const count = this._queue.filter((p) => !p.done).length;
      if (count > 0) {
        await this.rollback();
        throw new Error(
          `Unfinished operations detected (${count}). Make sure that updater callback is async function and there are no floating promises inside.`,
        );
      }
      // if there is no changes, abort commit
      if (!options?.force && !this._inventory.isChanged) {
        return await this.rollback();
      }
      try {
        await this._commit(options);
      } catch (error) {
        await this.rollback();
        throw error;
      }
      this._object._setInventory(this._inventory);
      this._committed = true;
      await this._removeWorkspaceIfEmpty();
    }
  }

  /** Remove everything this transaction created, restoring the root inventory if it was replaced */
  async _undo() {
    const store = this._store;
    const root = this._object.root;
    const rootInv = this._rootInventoryPaths;
    if (this._rootInventoryReplaced) {
      if (this._previousRootInventory) {
        await store.writeFile(rootInv.inventoryTmp, this._previousRootInventory);
        await store.move(rootInv.inventoryTmp, rootInv.inventory);
      } else {
        await store.remove(rootInv.inventory);
      }
    }
    if (this._rootInventoryStaged) {
      await store.remove(rootInv.inventoryTmp);
      await store.remove(rootInv.digestTmp);
    }
    await store.remove(this._versionPath);
    if (this._createdNamaste) {
      await store.remove(this._createdNamaste);
    }
    if (!this._rootExisted) {
      await this._tidy(root);
    }
    await this._removeWorkspaceIfEmpty();
  }

  async _removeWorkspaceIfEmpty() {
    if (this._workspace) {
      await this._tidy(this._workspace);
    }
  }

  /** A leftover empty directory is harmless, so failing to remove one must not mask the update's outcome */
  async _tidy(dirPath: string) {
    await this._store.removeIfEmpty(dirPath).catch(() => {});
  }

  get _rootInventoryPaths() {
    const inventory = path.join(this._object.root, INVENTORY_NAME);
    const digest = `${inventory}.${this._inventory.digestAlgorithm}`;
    return { inventory, digest, inventoryTmp: `${inventory}.tmp`, digestTmp: `${digest}.tmp` };
  }

  async _commit(options: CommitOptions = {}) {
    const inventory = this._inventory;
    const digestAlgorithm = inventory.digestAlgorithm;
    // set commit info
    inventory.created = new Date().toISOString();
    if (options.message) {
      inventory.message = options.message;
    }
    if (options.user) {
      inventory.user = options.user;
    }

    const objectVersionPath = path.join(this._object.root, inventory.head);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json */
    let invPath = path.join(this._versionPath, INVENTORY_NAME);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json.sha512 */
    let invDigestPath = `${invPath}.${digestAlgorithm}`;

    const inventoryContent = inventory.toString();
    inventory._digest = await OcflDigest.digest(digestAlgorithm, inventoryContent);
    const digest = `${inventory._digest} ${INVENTORY_NAME}`;

    // write inventory.json to workspace
    await this._store.writeFile(invPath, inventoryContent);
    await this._store.writeFile(invDigestPath, digest);
    if (this._workspace) {
      this._createdNamaste = await this._object._ensureNamaste();
      await this._store.move(this._versionPath, objectVersionPath);
      this._versionPath = objectVersionPath;
    }
    // replace root inventory
    const rootInv = this._rootInventoryPaths;
    /* eg: /data/aa/bb/cc/object-1/v1/inventory.json */
    invPath = path.join(objectVersionPath, INVENTORY_NAME);
    invDigestPath = `${invPath}.${digestAlgorithm}`;
    this._rootInventoryStaged = true;
    await this._store.copyFile(invPath, rootInv.inventoryTmp);
    await this._store.copyFile(invDigestPath, rootInv.digestTmp);
    if (inventory.versionNumber.previous()) {
      this._previousRootInventory = await this._store.readFile(rootInv.inventory);
    }
    await this._store.move(rootInv.inventoryTmp, rootInv.inventory);
    this._rootInventoryReplaced = true;
    await this._store.move(rootInv.digestTmp, rootInv.digest);
  }

  async createWritable(logicalPath: string, options?: unknown): Promise<WritableStream> {
    if (this._committed) {
      throw new Error('Transaction already commited');
    }
    const digestAlgo = this._inventory.digestAlgorithm;
    const digestAlgos = [digestAlgo, ...(this._object.fixityAlgorithms || [])];
    const hs = await OcflDigest.createStream(digestAlgos);
    const realPath = this._getRealPath(logicalPath);
    const writer = (await this._store.createWritable(realPath, options)).getWriter();
    const inv = this._inventory;
    const store = this._store;
    const ws = new WritableStream({
      write(chunk) {
        hs.update(chunk);
        return writer.write(chunk);
      },
      async close() {
        await writer.close();
        const [digest, fixity] = splitDigests(hs.digest(), digestAlgo);
        if (inv.getContentPath(digest)) {
          await store.remove(realPath);
        }
        inv.add(logicalPath, digest, fixity);
      },
    });
    this._writers.add(writer);
    const forget = () => this._writers.delete(writer);
    writer.closed.then(forget, forget);
    this._track(writer.closed);

    return ws;
  }

  async write(logicalPath: string, data: WriteFileData, options?: object | string) {
    return this._transact(async () => {
      const realPath = this._getRealPath(logicalPath);
      const digestAlgo = this._inventory.digestAlgorithm;
      const digestAlgos = [digestAlgo, ...(this._object.fixityAlgorithms || [])];
      let digest: string;
      let fixity: { [algorithm: string]: string };
      if (typeof data === 'string' || ArrayBuffer.isView(data)) {
        // if data is not stream, check digest first
        if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Uint32Array)) {
          data = new Uint8Array(data.buffer);
        }
        const hashes = await OcflDigest.digest(digestAlgos, data as string | Uint8Array);
        [digest, fixity] = splitDigests(hashes, digestAlgo);
        if (!this._inventory.getContentPath(digest)) {
          // no digest yet, write the file to storage backend
          await this._store.writeFile(realPath, data, options);
        }
      } else if (data instanceof ReadableStream) {
        // save the stream first
        const hs = await OcflDigest.createStreamThrough(digestAlgos);
        const rs = data.pipeThrough(hs);
        await this._store.writeFile(realPath, rs, options);
        [digest, fixity] = splitDigests(hs.digest(), digestAlgo);
        // already exists, delete temp file
        if (this._inventory.getContentPath(digest)) {
          await this._store.remove(realPath);
        }
      } else {
        throw new TypeError(`Unsupported data type: ${Object.prototype.toString.call(data)}`);
      }
      this._inventory.add(logicalPath, digest, fixity);
    });
  }

  /**
   * Import a single file from source. This is a helper method for {@link OcflObjectTransaction.import | import()} method.
   */
  async importFile(source: string, target: string) {
    if (!target) {
      throw new TypeError('Target logical path must not be empty if source is a file.');
    }
    const realPath = this._getRealPath(target);
    const rs = await this._store.createReadable(source);
    const digestAlgo = this._inventory.digestAlgorithm;
    const digestAlgos = [digestAlgo, ...(this._object.fixityAlgorithms || [])];
    const [digest, fixity] = splitDigests(await OcflDigest.digest(digestAlgos, rs), digestAlgo);

    if (!this._inventory.getContentPath(digest)) {
      await this._store.copyFile(source, realPath);
    }
    this._inventory.add(target, digest, fixity);
  }

  async import(source: string, target?: string) {
    return this._transact(async () => {
      const dest = target ?? path.basename(source);
      checkLogicalPath(dest);
      const srcStat = await this._store.stat(source);
      if (srcStat.isFile()) {
        await this.importFile(source, dest);
      } else if (srcStat.isDirectory()) {
        const files = await this._store.readdir(source);
        const res = await parallelize(files, async (filename) => {
          await this.import(path.join(source, filename), path.join(dest, filename));
        });
        const errors = res.filter((r) => r instanceof Error);
        if (errors.length) {
          throw new AggregateError(errors, `Cannot import the directory ${source}`);
        }
      }
    });
  }

  async copy(source: string, target: string) {
    return this._transact(async () => {
      checkLogicalPath(target);
      this._inventory.copy(source, target);
    });
  }

  async rename(source: string, target: string) {
    return this._transact(async () => {
      // if file already exists in the workspace, rename the actual file
      try {
        const realSource = this._getRealPath(source);
        const realTarget = this._getRealPath(target);
        await this._store.move(realSource, realTarget);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      this._inventory.rename(source, target);
    });
  }

  async reinstate(logicalPath: string, versionName: string) {
    return this._inventory.reinstate(logicalPath, versionName);
  }

  async remove(logicalPath: string, options?: RemoveOptions) {
    return this._transact(async () => {
      const realPath = this._getRealPath(logicalPath);
      if (options?.purge) {
        // completely remove content from all versions
        let ver = this._inventory.versionNumber.previous();
        while (ver) {
          this._inventory.delete(logicalPath, ver.toString());
          ver = ver.previous();
        }
      }
      if (this._inventory.delete(logicalPath)) {
        return this._store.remove(realPath);
      }
    });
  }

  /**
   * A function wrapper to provide safe mutating operation that
   * will check if a transaction is already committed and track any unfinished promises.
   */
  async _transact<T>(op: () => Promise<T>): Promise<T> {
    if (this._committed) {
      throw new Error('Transaction already commited');
    }
    return this._track(op());
  }

  private _track<T>(p: TrackedPromise<T>): Promise<T> {
    const markDone = () => {
      p.done = true;
    };
    // then(f, f), not finally(f): finally's derived promise would reject unhandled.
    p.then(markDone, markDone);
    this._queue.push(p);
    return p;
  }
}

export { OcflObjectTransaction, OcflObjectTransactionImpl };
