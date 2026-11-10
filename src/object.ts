import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import * as Hashing from './digest.ts';
import { ObjectNotFoundError, ObjectNotLoadedError, OcflError } from './error.ts';
import type { FileRef } from './file.ts';
import { OcflObjectFile } from './file.ts';
import { type InventoryFile, OcflObjectInventory, OcflObjectInventoryMut, VersionNumber } from './inventory.ts';
import * as store from './store.ts';
import { type CommitOptions, type ImportSource, OcflObjectTransaction } from './transaction.ts';
import type { BinaryOptions, ContentAlgorithm, EncodingOptions, Inventory, OcflObjectConfig, OcflVersion } from './types.ts';
import { findNamasteVersion, isDirEmpty, isNotFound, pathExists } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T, EXTENSIONS_DIR } = OcflConstants;
const INVENTORY_TYPE = /^https:\/\/ocfl\.io\/([^/]+)\/spec\/#inventory$/;
const MUTABLE_HEAD_INVENTORY = path.join(EXTENSIONS_DIR, '0005-mutable-head', 'head', INVENTORY_NAME);

export type UpdateMode = 'MERGE' | 'REPLACE';

/** How `OcflObject.update()` and `OcflObject.import()` create a version */
export interface UpdateOptions extends CommitOptions {
  /** `'MERGE'` starts the new version from the previous version's files, and `'REPLACE'` starts it empty; earlier versions and the manifest are kept in both. Defaults to `'MERGE'`. */
  mode?: UpdateMode | undefined;
}
export type LogicalPath = string;
export type FileRefLogical = { logicalPath: string; version?: string | undefined };
export type FileRefDigest = { digest: string; version?: string | undefined };
export type FileRefContent = { contentPath: string; version?: string | undefined };
function contentDigestAlgorithm(algorithm: string | undefined): ContentAlgorithm {
  const name = algorithm || 'sha512';
  if (name !== 'sha256' && name !== 'sha512') {
    throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
  }
  return name;
}

/** Failures of reading a root inventory that a writer has only partly replaced. `#readInventory` handles a missing inventory, so ENOENT means its sidecar. */
function isMidCommitRead(err: unknown) {
  return err instanceof SyntaxError || isNotFound(err) || (err instanceof OcflError && err.code === 'E060');
}

/**
 * A class representing an OCFL Object allowing to read and write the content of an OCFL Object on the filesystem.
 */
class OcflObject {
  #configuredOcflVersion: OcflVersion;
  #root: string;
  #workspace: string | undefined;
  #id: string | undefined;
  #digestAlgorithm: ContentAlgorithm;
  #contentDirectory: string;
  /**
   * A default list of digest algorithms to be calculated for each file in this object and added to the fixity block.
   */
  fixityAlgorithms: string[] | undefined;
  #inventories: { [version: string]: OcflObjectInventory } = {};
  #latestRead = false;

  /** @internal */
  constructor(config: OcflObjectConfig) {
    if (!config.root) {
      throw new TypeError('[OcflObject] config.root is required.');
    }
    if (config.root === config.workspace) {
      throw new Error('[OcflObject] config.root and config.workspace must be different.');
    }
    this.#root = path.resolve(config.root);
    this.#configuredOcflVersion = config.ocflVersion || OCFL_VERSION;
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.#digestAlgorithm = contentDigestAlgorithm(config.digestAlgorithm);
    this.#workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.#contentDirectory = config.contentDirectory ?? 'content';
    this.fixityAlgorithms = config.fixityAlgorithms;
  }

  /**
   * The digest algorithm used to identify files within the OCFL object. For an existing object, only reliable once its
   * root inventory has been read, by {@link OcflObject.load} or any method that reads it. Until then, and for an object that
   * doesn't exist yet, this is the configured algorithm or the library default.
   */
  get digestAlgorithm(): ContentAlgorithm {
    return this.inventory?.digestAlgorithm ?? this.#digestAlgorithm;
  }

  /**
   * The name of the directory holding each version's content. For an existing object, only reliable once its root
   * inventory has been read, by {@link OcflObject.load} or any method that reads it. Until then, and for an object that doesn't
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
   * has been read, by {@link OcflObject.load} or any method that reads it. Until then, and for an object that doesn't exist yet,
   * this is the configured version or the library default.
   */
  get ocflVersion(): OcflVersion {
    const declared = this.inventory && INVENTORY_TYPE.exec(this.inventory.type)?.[1];
    return (declared as OcflVersion | undefined) ?? this.#configuredOcflVersion;
  }

  /**
   * @returns The path of the declaration file, if this call wrote one
   * @internal
   */
  async _ensureNamaste(): Promise<string | undefined> {
    const prefix = NAMASTE_PREFIX_OBJECT;
    const nv = await findNamasteVersion(prefix, this.root);
    if (nv === '') {
      throw createError('E007', this.root);
    }
    if (nv) {
      return;
    }
    if (!(await isDirEmpty(this.root))) {
      throw new OcflError('DIRECTORY_NOT_EMPTY', 'Cannot create an OCFL Object in a non-empty directory');
    }
    //create the namaste file
    const filePath = path.join(this.root, NAMASTE_T + prefix + this.ocflVersion);
    await store.writeFile(filePath, `${prefix + this.ocflVersion}\n`);
    return filePath;
  }

  /**
   * Read and parse the inventory.json file
   * @param version - Full name of the version, eg: v1, v2, v3
   */
  async #readInventory(version: string = 'latest'): Promise<OcflObjectInventory | undefined> {
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
   * @internal
   */
  _setInventory(inventory: OcflObjectInventory, version = 'latest') {
    this.#inventories[version] = inventory;
    if (version === 'latest') {
      this.#inventories[inventory.head] = inventory;
    }
  }

  /**
   * Rejects an object root inside another OCFL object
   * @internal
   */
  async _validateObjectPath() {
    var p = this.root;
    while (p !== '.' && p !== '/') {
      p = path.dirname(p);
      const nv = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, p);
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
    if (!this.#inventories[version]) {
      const inv = await this.#readInventory(version);
      if (inv) {
        this._setInventory(inv, version);
      }
      if (version === 'latest') {
        this.#latestRead = true;
      }
    }
    return this.#inventories[version];
  }

  /** @internal */
  async _requireInventory(): Promise<OcflObjectInventory> {
    const inv = await this.getInventory();
    if (!inv) {
      throw new ObjectNotFoundError(this.#label);
    }
    return inv;
  }

  #baseInventory() {
    return {
      ...(this.id === undefined ? {} : { id: this.id }),
      digestAlgorithm: this.digestAlgorithm || 'sha512',
      type: `https://ocfl.io/${this.ocflVersion}/spec/#inventory` as Inventory['type'],
      contentDirectory: this.contentDirectory || 'content',
    };
  }

  /**
   * Update the content files or directories as one transaction and commit the changes as a new version.
   * With an `updater`, the changes it makes are committed when it resolves, with the message and user in `options`,
   * and rolled back if it rejects.
   * Without one, the transaction is returned, and the caller must call {@link OcflObjectTransaction.commit},
   * which takes the message and user, or {@link OcflObjectTransaction.rollback}.
   * @throws `TypeError` if `options` isn't an object, has an unknown mode, or has a message or user without an `updater`
   * @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE` if the object has an active mutable head (extension 0005); nothing is written
   */
  async update(updater?: (transaction: OcflObjectTransaction) => Promise<unknown>, options: UpdateOptions = {}): Promise<OcflObjectTransaction | undefined> {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError(`Options must be an object, such as { mode: 'REPLACE' }, not ${String(options)}`);
    }
    const { mode = 'MERGE', ...commitOptions } = options;
    if (mode !== 'MERGE' && mode !== 'REPLACE') {
      throw new TypeError(`Invalid mode '${mode}'`);
    }
    if (typeof updater !== 'function' && (commitOptions.message !== undefined || commitOptions.user !== undefined)) {
      throw new TypeError('Without an updater, pass the message and user to commit()');
    }
    const inv = (await this.getInventory()) ?? this.#baseInventory();
    const newInv = OcflObjectInventoryMut.newVersion(inv, mode === 'REPLACE');
    await this._validateObjectPath();
    if (await pathExists(path.join(this.root, MUTABLE_HEAD_INVENTORY))) {
      throw new OcflError(
        'MUTABLE_HEAD_ACTIVE',
        `OCFL Object "${this.#label}" has an active mutable head (extension 0005), which this library doesn't support; new versions can't be created until it is committed or removed`,
      );
    }
    const t = await OcflObjectTransaction.create(this, newInv, this.workspace || this.root);
    if (typeof updater === 'function') {
      try {
        await updater(t);
      } catch (error) {
        await t.rollback();
        throw error;
      }
      await t.commit(commitOptions);
      return;
    }
    return t;
  }

  /**
   * Import a file or directory from the local filesystem as one new version.
   * `target` is the logical path the source becomes, as in {@link OcflObjectTransaction.import}: without one,
   * a directory's contents go at the object root and a file keeps its own name there.
   * @param source - A path to a file or directory in the local filesystem
   * @param target - The logical path the source becomes
   * @param options - The mode, and the message and user recorded in the version
   * @throws The errors of {@link OcflObjectTransaction.import} and {@link OcflObject.update}
   */
  async import(source: string, target?: string, options?: UpdateOptions): Promise<void>;
  /**
   * Import a file or directory from the local filesystem as one new version, without a target.
   * @param source - A path to a file or directory in the local filesystem
   * @param options - The mode, and the message and user recorded in the version
   * @throws The errors of {@link OcflObjectTransaction.import} and {@link OcflObject.update}
   */
  async import(source: string, options: UpdateOptions): Promise<void>;
  /**
   * Import several files or directories from the local filesystem as one new version.
   * @param sources - Each source, and the logical path it becomes
   * @param options - The mode, and the message and user recorded in the version
   * @throws {@link OcflError} `FILE_EXISTS` if two sources produce the same logical path
   * @throws The errors of {@link OcflObjectTransaction.import} and {@link OcflObject.update}
   */
  async import(sources: ImportSource[], options?: UpdateOptions): Promise<void>;
  async import(sources: string | ImportSource[], targetOrOptions?: string | UpdateOptions, options?: UpdateOptions): Promise<void> {
    const target = typeof targetOrOptions === 'string' ? targetOrOptions : undefined;
    const updateOptions = typeof targetOrOptions === 'object' ? targetOrOptions : options;
    const items = typeof sources === 'string' ? [{ source: sources, target }] : sources;
    await this.update(async (t) => t._importAll(items), updateOptions);
  }

  /**
   * Count the number of files contained in this object
   */
  async count(version?: string): Promise<number> {
    const inv = await this._requireInventory();
    return [...inv.files(version)].length;
  }

  async createReadable(filePath: string, options?: unknown): Promise<ReadableStream> {
    return store.createReadable(path.join(this.root, filePath), options);
  }

  /**
   * Check if the object root path points to an existing file or non-empty directory.
   * The existing directory may or may not be a valid OCFL Object.
   */
  async exists(): Promise<boolean> {
    return !(await isDirEmpty(this.root));
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
   * @throws {@link ObjectNotLoadedError} If not lazy and the inventory has not been read, by {@link OcflObject.load} or any method that reads it.
   * @throws {@link ObjectNotFoundError} If not lazy and the loaded object does not exist.
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
   * Return the latest version of the cached data from inventory.json which can be read using {@link OcflObject.getInventory}
   */
  get inventory(): OcflObjectInventory | undefined {
    return this.#inventories.latest;
  }

  /**
   * Reads the object inventory file and cache it in the memory.
   * Optionally, preloads and reads all files metadata from the filesystem.
   */
  async load({ filesMetadata }: { filesMetadata?: boolean | undefined } = {}): Promise<void> {
    const inv = await this.#readInventory();
    this.#inventories = {};
    if (inv) {
      this._setInventory(inv);
    }
    this.#latestRead = true;
    if (inv && filesMetadata) {
      const metadata: OcflObjectInventory['metadata'] = {};
      inv.metadata = metadata;
      for await (const file of store.listFiles(this.root)) {
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
   * With nothing cached, behaves like {@link OcflObject.load}.
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
      inventory = await this.#readInventory();
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
      this.#inventories = {};
    }
  }

  /**
   * Read the content of a file inside an object.
   * @param relPath - The file path relative to the object root.
   * @param options - Options passed to `fs.promises.readFile`
   */
  async readFile(relPath: string, options: EncodingOptions): Promise<string>;
  async readFile(relPath: string, options?: BinaryOptions): Promise<Uint8Array>;
  async readFile(relPath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array>;
  async readFile(relPath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array> {
    return fs.promises.readFile(path.join(this.root, relPath), options);
  }

  /**
   * Get the file metadata such as size and modification time.
   * @param relPath - The file path relative to the object root.
   */
  async stat(relPath: string): Promise<fs.Stats> {
    return fs.promises.stat(path.join(this.root, relPath));
  }

  get #label() {
    return this.id ?? this.root;
  }

  toString(): string {
    return `OcflObject { root: ${this.root}, id: ${this.id} }`;
  }

  toJSON(): { root: string; id: string | undefined } {
    return { root: this.root, id: this.id };
  }
}

export { OcflObject };
