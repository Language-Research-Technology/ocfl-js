import path from 'node:path';
import type { BinaryOptions, EncodingOptions, OcflStore } from './backend-store.ts';
import { OcflConstants } from './constants.ts';
import { type ContentAlgorithm, Hashing } from './digest.ts';
import { ObjectNotFoundError, ObjectNotLoadedError, OcflError } from './error.ts';
import type { FileRef } from './file.ts';
import { OcflObjectFile } from './file.ts';
import { type InventoryFile, OcflObjectInventory, OcflObjectInventoryMut, VersionNumber } from './inventory.ts';
import { type OcflObjectTransaction, OcflObjectTransactionImpl } from './transaction.ts';
import type { Inventory, OcflObjectConfig, OcflVersion } from './types.ts';
import { findNamasteVersion, isDirEmpty, isNotFound, parallelize } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;
const INVENTORY_TYPE = /^https:\/\/ocfl\.io\/([^/]+)\/spec\/#inventory$/;

export type UpdateMode = 'MERGE' | 'REPLACE';
type LogicalPath = string;
type FileRefLogical = { logicalPath: string; version?: string | undefined };
type FileRefDigest = { digest: string; version?: string | undefined };
type FileRefContent = { contentPath: string; version?: string | undefined };
function contentDigestAlgorithm(algorithm: string | undefined): ContentAlgorithm {
  const name = algorithm || 'sha512';
  if (name !== 'sha256' && name !== 'sha512') {
    throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
  }
  return name;
}

/** Failures of reading a root inventory that a writer has only partly replaced. `_readInventory` handles a missing inventory, so ENOENT means its sidecar. */
function isMidCommitRead(err: unknown) {
  return err instanceof SyntaxError || isNotFound(err) || (err instanceof OcflError && err.code === 'E060');
}

/**
 * A class representing an OCFL Object allowing to read and write the content of an OCFL Object in the underlying store.
 */
class OcflObject {
  #configuredOcflVersion: OcflVersion;
  #root: string;
  #workspace: string | undefined;
  #id: string | undefined;
  #digestAlgorithm: ContentAlgorithm;
  #contentDirectory: string;
  #store: OcflStore;
  /**
   * A default list of digest algorithms to be calculated for each file in this object and added to the fixity block.
   */
  fixityAlgorithms: string[] | undefined;
  _inventory: { [version: string]: OcflObjectInventory } = {};
  #latestRead = false;

  /**
   * Create a new OCFL Object
   */
  constructor(config: OcflObjectConfig, store: OcflStore) {
    if (!store) {
      throw new TypeError('[OcflObject] store is required.');
    }
    this.#store = store;
    if (!config.root) {
      throw new TypeError('[OcflObject] config.root is required.');
    }
    if (config.root === config.workspace) {
      throw new Error('[OcflObject] config.root and config.workspace must be different.');
    }
    this.#root = path.resolve(config.root);
    this.#configuredOcflVersion = config.ocflVersion || (OCFL_VERSION as OcflVersion);
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.#digestAlgorithm = contentDigestAlgorithm(config.digestAlgorithm);
    this.#workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.#contentDirectory = config.contentDirectory ?? 'content';
    this._inventory = {};
    this.fixityAlgorithms = config.fixityAlgorithms;
  }

  /**
   * The digest algorithm used to identify files within the OCFL object. For an existing object, only reliable once its
   * root inventory has been read, by {@link load} or any method that reads it. Until then, and for an object that
   * doesn't exist yet, this is the configured algorithm or the library default.
   */
  get digestAlgorithm(): ContentAlgorithm {
    return this.inventory?.digestAlgorithm ?? this.#digestAlgorithm;
  }

  /**
   * The name of the directory holding each version's content. For an existing object, only reliable once its root
   * inventory has been read, by {@link load} or any method that reads it. Until then, and for an object that doesn't
   * exist yet, this is the configured directory or the library default.
   */
  get contentDirectory(): string {
    return this.inventory?.contentDirectory ?? this.#contentDirectory;
  }

  /**
   * Identifier of the OCFL Object
   */
  get id(): string | undefined {
    return this.inventory?.id || this.#id;
  }

  /**
   * Latest version number of the OCFL Object
   */
  get headVersion(): VersionNumber | undefined {
    const head = this.inventory?.head;
    return head ? VersionNumber.fromString(head) : undefined;
  }

  /**
   * All available version numbers in the OCFL Object
   */
  get versions(): VersionNumber[] {
    return Object.keys(this.inventory?.versions || {}).map((v) => VersionNumber.fromString(v));
  }

  /**
   * The absolute path to the root of this OCFL Object
   */
  get root(): string {
    return this.#root;
  }

  /**
   * The absolute path to the temporary workspace of this OCFL Object
   */
  get workspace(): string | undefined {
    return this.#workspace;
  }

  /**
   * The OCFL version the object adheres to, eg 1.0, 1.1. For an existing object, only reliable once its root inventory
   * has been read, by {@link load} or any method that reads it. Until then, and for an object that doesn't exist yet,
   * this is the configured version or the library default.
   */
  get ocflVersion(): OcflVersion {
    const declared = this.inventory && INVENTORY_TYPE.exec(this.inventory.type)?.[1];
    return (declared as OcflVersion | undefined) ?? this.#configuredOcflVersion;
  }

  /**
   * Create a new backend-specific update transaction
   */
  async #createTransaction(inventory: OcflObjectInventoryMut): Promise<OcflObjectTransaction> {
    await this._validateObjectPath();
    const workspacePath = this.workspace || this.root;
    return OcflObjectTransactionImpl.create(this, this.#store, inventory, workspacePath);
  }

  /** @returns The path of the declaration file, if this call wrote one */
  async _ensureNamaste(): Promise<string | undefined> {
    const prefix = NAMASTE_PREFIX_OBJECT;
    const nv = await findNamasteVersion(this.#store, prefix, this.root);
    if (nv === '') {
      throw createError('E007', this.root);
    }
    if (nv) {
      return;
    }
    // namaste not found, check if object root is not empty
    let files: string[] | undefined;
    try {
      files = await this.#store.readdir(this.root);
    } catch (_error) {}
    if (files && files.length > 0) {
      throw new OcflError('DIRECTORY_NOT_EMPTY', 'Cannot create an OCFL Object in a non-empty directory');
    }
    //create the namaste file
    const filePath = path.join(this.root, NAMASTE_T + prefix + this.ocflVersion);
    await this.#store.writeFile(filePath, `${prefix + this.ocflVersion}\n`, 'utf8');
    return filePath;
  }

  /**
   * Read and parse the inventory.json file
   * @param version - Full name of the version, eg: v1, v2, v3
   */
  async _readInventory(version: string = 'latest'): Promise<OcflObjectInventory | undefined> {
    const invPath = version === 'latest' ? INVENTORY_NAME : path.join(version, INVENTORY_NAME);
    let datastr: string;
    try {
      datastr = await this.readFile(invPath, 'utf8');
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      //inventory does not exist yet
      return;
    }
    const data = JSON.parse(datastr) as Inventory;
    const [digest, actualDigest] = await Promise.all([this.#readSidecarDigest(invPath, data.digestAlgorithm), Hashing.digest(data.digestAlgorithm, datastr)]);
    if (digest !== actualDigest) {
      throw createError('E060', path.join(this.root, invPath), `recorded=${digest} actual=${actualDigest}`);
    }
    if (data.head === undefined) {
      throw createError('E036', path.join(this.root, invPath), 'missing head');
    }
    if (data.head === '') {
      throw createError('E040', path.join(this.root, invPath), 'empty head');
    }
    const inventory = new OcflObjectInventory(data);
    inventory._digest = actualDigest;
    return inventory;
  }

  async #readSidecarDigest(invPath: string, digestAlgorithm: string) {
    const sidecar = await this.readFile(`${invPath}.${digestAlgorithm}`, 'utf8');
    return sidecar.match(/[^\s]+/)?.[0];
  }

  /**
   * Set the latest version of inventory in the cache
   */
  _setInventory(inventory: OcflObjectInventory, version = 'latest') {
    //this._inventory['latest'] = this._inventory[inventory.head] = inventory;
    this._inventory[version] = inventory;
    if (version === 'latest') {
      this._inventory[inventory.head] = inventory;
    }
  }

  // all the parent directories cannot be an ocfl object
  async _validateObjectPath() {
    var p = this.root;
    while (p !== '.' && p !== '/') {
      p = path.dirname(p);
      const nv = await findNamasteVersion(this.#store, NAMASTE_PREFIX_OBJECT, p);
      if (nv) {
        throw createError('E082', this.root, `nested under the object at ${p}`);
      }
    }
  }

  /**
   * If a cache exists, return the cached inventory. Otherwise read it from the storage and cache it.
   * If the inventory file does not exist, eg in a newly created object, returns undefined.
   * @param version - Full name of the version, eg: v1, v2, v3
   */
  async getInventory(version: string = 'latest'): Promise<OcflObjectInventory | undefined> {
    if (!this._inventory[version]) {
      const inv = await this._readInventory(version);
      if (inv) {
        this._setInventory(inv, version);
      }
      if (version === 'latest') {
        this.#latestRead = true;
      }
    }
    return this._inventory[version];
  }

  async _requireInventory(): Promise<OcflObjectInventory> {
    const inv = await this.getInventory();
    if (!inv) {
      throw new ObjectNotFoundError(this.#label);
    }
    return inv;
  }

  _baseInventory() {
    return {
      ...(this.id === undefined ? {} : { id: this.id }),
      digestAlgorithm: this.digestAlgorithm || 'sha512',
      type: `https://ocfl.io/${this.ocflVersion}/spec/#inventory` as Inventory['type'],
      contentDirectory: this.contentDirectory || 'content',
    };
  }

  /**
   * Update the content files or directories as one transaction and commit the changes as a new version.
   * After obtaining the OcflObjectTransaction instance, make sure to either call the
   * {@link OcflObjectTransaction#commit} or {@link OcflObjectTransaction#rollback} method to complete the transaction.
   * If callback function `cb` is provided, all update operations can be done in the callback function
   * and all changes are automatically commited at the end of the function.
   */
  async update(updater?: (transaction: OcflObjectTransaction) => Promise<unknown>, mode_: UpdateMode = 'MERGE'): Promise<OcflObjectTransaction | undefined> {
    if (mode_ !== 'MERGE' && mode_ !== 'REPLACE') {
      throw new TypeError(`Invalid mode '${mode_}'`);
    }
    const inv = (await this.getInventory()) ?? this._baseInventory();
    const newInv = OcflObjectInventoryMut.newVersion(inv, mode_ === 'REPLACE');
    const t = await this.#createTransaction(newInv);
    if (typeof updater === 'function') {
      try {
        await updater(t);
      } catch (error) {
        // console.log(error);
        await t.rollback();
        throw error;
      }
      await t.commit();
      return;
    }
    return t;
  }

  /**
   * Import one or more content files or directories to the object
   * in one transaction and commit the changes as a new version.
   * Use this method to simplify copying all contents of a directory
   * in local filesystem to the OCFL Object content directory
   * @param content - The source path(s) or an array of a tuple [source, logical path]
   * @param mode - Update mode. Defaults to `'MERGE'`.
   */
  async import(content: string | string[] | string[][], mode: UpdateMode = 'MERGE') {
    const items = typeof content === 'string' ? [[content, '']] : content.map((p) => (typeof p === 'string' ? [p, ''] : p));

    await this.update(async (t) => {
      const res = await parallelize([...items], async ([source = '', target]) => t.import(source, target));
      const errors = res.filter((r) => r instanceof Error);
      if (errors.length) {
        const sources = items.filter((_, i) => res[i] instanceof Error).map(([source]) => source);
        throw new AggregateError(errors, `Cannot add the files: ${sources.join(', ')}`);
      }
    }, mode);
  }

  /**
   * Count the number of files contained in this object
   */
  async count(version?: string) {
    const inv = await this._requireInventory();
    return [...inv.files(version)].length;
  }

  async createReadable(filePath: string, options?: unknown): Promise<ReadableStream> {
    return this.#store.createReadable(path.join(this.root, filePath), options);
  }

  /**
   * Check if the object root path points to an existing file or non-empty directory
   * in the underlying backend store.
   * The existing directory may or may not be a valid OCFL Object.
   */
  async exists(): Promise<boolean> {
    return !(await isDirEmpty(this.#store, this.root));
  }

  /**
   * Iterate through the content files contained in the specified version.
   * Returns an Iterator that contains FileRef which consists of logical path, content path, and digest, in no particular order.
   * The iterator is implemented as a generator.
   */
  async files(version?: string): Promise<Generator<OcflObjectFile, void, unknown>> {
    const inv = await this._requireInventory();
    const o = this;
    function* files() {
      for (const f of inv.files(version)) {
        yield new OcflObjectFile(o, f);
      }
    }
    return files();
  }

  /**
   * Return a file representation by either the [logical path and version], digest, or content path.
   * The returned file object can be used to retrieve the content of a file either as string, buffer, or stream.
   * If the object inventory file is not loaded, this file object will not include the full file metadata information.
   * If version is omitted, it defaults to the last version.
   * @param opt - A choice of logical path (eg: 'test') and version (eg: 'v1'),
   * digest of the file content, or content path (eg: 'v1/content/test')
   * @param version - The object version name, eg: 'v1', 'v2'. Default to 'latest'. Only used if opt is a LogicalPath. Defaults to `'latest'`.
   * @param lazy - If true, always return a file instance even if the object inventory file is not loaded.
   * @returns `undefined` if the object has no such file.
   * @throws {ObjectNotLoadedError} If not lazy and the inventory has not been read, by {@link load} or any method that reads it.
   * @throws {ObjectNotFoundError} If not lazy and the loaded object does not exist.
   */
  getFile(opt: LogicalPath | FileRefLogical | FileRefDigest | FileRefContent, version?: string, lazy?: boolean): OcflObjectFile | undefined {
    const inv = this.inventory;
    const file: FileRef = typeof opt === 'string' ? { logicalPath: opt, version: version } : { ...opt };
    if (!inv) {
      if (lazy) {
        return new OcflObjectFile(this, file);
      }
      throw this.#latestRead ? new ObjectNotFoundError(this.#label) : new ObjectNotLoadedError(this.#label);
    }
    let fr: InventoryFile | undefined;
    if (file.logicalPath) {
      fr = inv.getFile(file.logicalPath, file.version);
    } else if (file.digest) {
      fr = inv.getFileByDigest(file.digest, file.version);
    } else if (file.contentPath) {
      fr = inv.getFileByContentPath(file.contentPath, file.version);
    }
    if (fr) {
      return new OcflObjectFile(this, fr);
    }
  }

  /**
   * Return the latest version of the cached data from inventory.json which can be read using {@link getInventory()}
   */
  get inventory() {
    return this._inventory.latest;
  }

  /**
   * Reads the object inventory file and cache it in the memory.
   * Optionally, preloads and reads all files metadata from the underlying storage.
   */
  async load({ filesMetadata }: { filesMetadata?: boolean | undefined } = {}) {
    const inv = await this._readInventory();
    this._inventory = {};
    if (inv) {
      this._setInventory(inv);
    }
    this.#latestRead = true;
    if (inv && filesMetadata) {
      //load file metadata from underlying storage
      const metadata: OcflObjectInventory['metadata'] = {};
      inv.metadata = metadata;
      for await (const file of await this.#store.list(this.root, { recursive: true })) {
        const contentPath = file.path;
        metadata[contentPath] = {
          size: file.size,
          lastModified: file.lastModified.getTime(),
        };
      }
    }
  }

  /**
   * Bring the cached latest inventory up to date, reading only the sidecar file if the object hasn't changed.
   * A loaded object keeps its last good inventory if a commit is in progress, and a later refresh picks up the new version.
   * With nothing cached, behaves like {@link load}.
   * File metadata from `load({ filesMetadata: true })` doesn't carry over to a new inventory.
   */
  async refresh(): Promise<void> {
    const cached = this.inventory;
    if (!cached) {
      return this.load();
    }
    try {
      if ((await this.#readSidecarDigest(INVENTORY_NAME, cached.digestAlgorithm)) === cached._digest) {
        return;
      }
    } catch (err) {
      // Only the inventory can tell a deleted object from a changed digest algorithm
      if (!isNotFound(err)) {
        throw err;
      }
    }
    let inventory: OcflObjectInventory | undefined;
    try {
      inventory = await this._readInventory();
    } catch (err) {
      if (isMidCommitRead(err)) {
        return;
      }
      throw err;
    }
    // A load or commit that finished during the read has cached something newer
    if (this.inventory !== cached) {
      return;
    }
    if (inventory) {
      this._setInventory(inventory);
    } else {
      this._inventory = {};
    }
  }

  /**
   * Read the content of a file inside an object.
   * @param relPath - The file path relative to the object root.
   * @param options - Options to be passed to the underlying method
   */
  async readFile(relPath: string, options: EncodingOptions): Promise<string>;
  async readFile(relPath: string, options?: BinaryOptions): Promise<Uint8Array>;
  async readFile(relPath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array>;
  async readFile(relPath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array> {
    return this.#store.readFile(path.join(this.root, relPath), options);
  }

  /**
   * Get the file metadata such as size and modification time.
   * @param relPath - The file path relative to the object root.
   */
  async stat(relPath: string) {
    return this.#store.stat(path.join(this.root, relPath));
  }

  get #label() {
    return this.id ?? this.root;
  }

  toString() {
    return `OcflObject { root: ${this.root}, id: ${this.id} }`;
  }

  toJSON() {
    return { root: this.root, id: this.id };
  }
}

export { OcflObject };
