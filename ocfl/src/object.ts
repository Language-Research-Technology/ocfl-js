import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflDigest } from './digest.ts';
import { type EnumValue, enumeration } from './enum.ts';
import type { OcflExtension } from './extension.ts';
import type { FileRef } from './file.ts';
import { OcflObjectFile } from './file.ts';
import { type InventoryFile, OcflObjectInventory, type OcflObjectInventoryMut, VersionNumber } from './inventory.ts';
import type { OcflStore } from './store.ts';
import { type OcflObjectTransaction, OcflObjectTransactionImpl } from './transaction.ts';
import type { Inventory, OcflObjectConfig, OcflVersion } from './types.ts';
import { findNamasteVersion, isDirEmpty, isErrnoException, parallelize } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

const UPDATE_MODES = ['MERGE', 'REPLACE'] as const;
const UPDATE_MODE = enumeration(UPDATE_MODES);
const DIGEST = OcflDigest.CONTENT;

type UpdateModeStr = (typeof UPDATE_MODES)[number];
export type UpdateMode = EnumValue | UpdateModeStr;
type LogicalPath = string;
type FileRefLogical = { logicalPath: string; version?: string };
type FileRefDigest = { digest: string; version?: string };
type FileRefContent = { contentPath: string; version?: string };
function contentDigestAlgorithm(algorithm: string | undefined): 'sha256' | 'sha512' {
  const name = enumeration.of(DIGEST, algorithm || 'sha512')?.name;
  if (!name) {
    throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
  }
  return name as 'sha256' | 'sha512';
}

/**
 * A class representing an OCFL Object allowing to read and write the content of an OCFL Object in the underlying store.
 */
class OcflObject {
  #ocflVersion: OcflVersion;
  #root: string;
  #workspace: string | undefined;
  #id: string | undefined;
  #digestAlgorithm: 'sha256' | 'sha512';
  #extensions: OcflExtension[] | undefined;
  #store: OcflStore;
  /**
   * A default list of digest algorithms to be calculated for each file in this object and added to the fixity block.
   */
  fixityAlgorithms: string[] | undefined;
  contentDirectory: string;
  _inventory: { [version: string]: OcflObjectInventory } = {};

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
    this.#ocflVersion = config.ocflVersion || (OCFL_VERSION as OcflVersion);
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    this.#extensions = config.extensions;
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.#digestAlgorithm = contentDigestAlgorithm(config.digestAlgorithm);
    this.#workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.contentDirectory = config.contentDirectory ?? 'content';
    this._inventory = {};
    this.fixityAlgorithms = config.fixityAlgorithms;
  }

  /** the digest algorithm used to identify files within the OCFL object */
  get digestAlgorithm(): 'sha256' | 'sha512' {
    return this.#digestAlgorithm;
  }
  set digestAlgorithm(algorithm: string) {
    this.#digestAlgorithm = contentDigestAlgorithm(algorithm);
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

  /** The raw OCFL version number the object adheres to , eg 1.0, 1.1) */
  get ocflVersion() {
    return this.#ocflVersion;
  }

  /**
   * Create a new backend-specific update transaction
   */
  async #createTransaction(inventory: OcflObjectInventoryMut): Promise<OcflObjectTransaction> {
    await this._validateObjectPath();
    if (!this.workspace) {
      await this._ensureNamaste();
    }
    const workspacePath = this.workspace || this.root;
    return OcflObjectTransactionImpl.create(this, this.#store, inventory, workspacePath);
  }

  async _ensureNamaste() {
    const prefix = NAMASTE_PREFIX_OBJECT;
    const nv = await findNamasteVersion(this.#store, prefix, this.root);
    if (nv === '') {
      throw createError('E007', this.root);
    }
    if (nv) {
      if (!this.ocflVersion) {
        this.#ocflVersion = nv as OcflVersion;
      }
      return;
    }
    // namaste not found, check if object root is not empty
    let files: string[] | undefined;
    try {
      files = await this.#store.readdir(this.root);
    } catch (_error) {}
    if (files && files.length > 0) {
      throw new Error('Cannot create an OCFL Object in a non-empty directory');
    }
    //create the namaste file
    const filePath = path.join(this.root, NAMASTE_T + prefix + this.ocflVersion);
    await this.#store.writeFile(filePath, `${prefix + this.ocflVersion}\n`, 'utf8');
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
      if (!isErrnoException(err) || err.code !== 'ENOENT') {
        throw err;
      }
      //inventory does not exist yet
      return;
    }
    const data = JSON.parse(datastr) as Inventory;
    const [sidecar, actualDigest] = await Promise.all([
      this.readFile(`${invPath}.${data.digestAlgorithm}`, 'utf8'),
      OcflDigest.digest(data.digestAlgorithm, datastr),
    ]);
    const digest = sidecar.match(/[^\s]+/)?.[0];
    if (digest !== actualDigest) {
      throw createError('E060', path.join(this.root, invPath), `recorded=${digest} actual=${actualDigest}`);
    }
    //return new OcflObjectInventory({ data, digest });
    return new OcflObjectInventory(data);
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
    }
    return this._inventory[version];
  }

  async _requireInventory(): Promise<OcflObjectInventory> {
    const inv = await this.getInventory();
    if (!inv) {
      throw new Error(`OCFL Object "${this.id}" does not exist`);
    }
    return inv;
  }

  _baseInventory() {
    return {
      id: this.id,
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
  async update(
    updater?: (transaction: OcflObjectTransaction) => Promise<unknown>,
    mode_: UpdateMode = UPDATE_MODE.MERGE,
  ): Promise<OcflObjectTransaction | undefined> {
    const mode = enumeration.of(UPDATE_MODE, mode_);
    if (!mode) {
      throw new TypeError(`Invalid mode '${mode_}'`);
    }
    const inv = (await this.getInventory()) ?? this._baseInventory();
    const newInv = await OcflObjectInventory.newVersion(inv, mode === UPDATE_MODE.REPLACE);
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
   * @param mode - Update mode. Defaults to `UPDATE_MODE.MERGE`.
   */
  async import(content: string | string[] | string[][], mode: UpdateMode = UPDATE_MODE.MERGE) {
    if (typeof content === 'string') {
      content = [[content, '']];
    }

    await this.update(async (t) => {
      const res = await parallelize(content as string[][], async (p) => {
        if (typeof p === 'string') {
          p = [p, ''];
        }
        const [source, target] = p;
        return t.import(source, target);
      });
      const errors = [];
      for (let i = 0; i < res.length; ++i) {
        if (res[i] instanceof Error) {
          errors.push(content[i][0]);
        }
      }
      if (errors.length) {
        const msg = `Cannot add the files: ${errors.join(', ')}`;
        throw new Error(msg);
      }
    }, mode);
  }

  /**
   * Alias for import
   * @see {@link OcflObject.import}
   */
  async add(sourceDir: string | string[] | string[][], mode: UpdateMode = UPDATE_MODE.MERGE) {
    await this.import(sourceDir, mode);
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
   * Copy all content of this Object to a directory in local filesystem
   */
  async export(_targetDir: string, _version: string) {
    throw new Error('Not Implemented');
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
   * Return a file representation by the content path and version,
   * @param version - Defaults to `'latest'`.
   */
  async fileByContentPath(contentPath: string, version?: string) {
    const inv = await this.getInventory();
    const fr = inv?.getFileByContentPath(contentPath, version);
    if (fr) {
      return new OcflObjectFile(this, fr);
    }
  }

  /**
   * Return a file representation by the digest and version,
   * @param version - Defaults to `'latest'`.
   */
  async fileByDigest(digest: string, version?: string) {
    const inv = await this.getInventory();
    const fr = inv?.getFileByDigest(digest, version);
    if (fr) {
      return new OcflObjectFile(this, fr);
    }
  }

  /**
   * Return a file representation by the logical path and version,
   * @param version - Defaults to `'latest'`.
   */
  async fileByLogicalPath(logicalPath: string, version?: string) {
    const inv = await this.getInventory();
    const fr = inv?.getFile(logicalPath, version);
    if (fr) {
      return new OcflObjectFile(this, fr);
    }
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
   */
  getFile(opt: LogicalPath | FileRefLogical | FileRefDigest | FileRefContent, version?: string, lazy?: boolean): OcflObjectFile | undefined {
    const inv = this.inventory;
    const file: FileRef = typeof opt === 'string' ? { logicalPath: opt, version: version } : { ...opt };
    if (inv) {
      let fr: InventoryFile | undefined;
      if (file.logicalPath) {
        fr = inv?.getFile(file.logicalPath, file.version);
      } else if (file.digest) {
        fr = inv?.getFileByDigest(file.digest, file.version);
      } else if (file.contentPath) {
        fr = inv?.getFileByContentPath(file.contentPath, file.version);
      }
      if (fr) {
        return new OcflObjectFile(this, fr);
      }
    } else if (lazy) {
      return new OcflObjectFile(this, file);
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
  async load({ filesMetadata }: { filesMetadata?: boolean } = {}) {
    this._inventory = {}; // reset inventory cache
    const inv = await this.getInventory();
    //await this.loadExtensions();
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
   * Read the content of a file inside an object.
   * @param relPath - The file path relative to the object root.
   * @param options - Options to be passed to the underlying method
   */
  async readFile(relPath: string, options: BufferEncoding | { encoding: BufferEncoding }): Promise<string>;
  async readFile(relPath: string, options?: unknown): Promise<Uint8Array>;
  async readFile(relPath: string, options?: unknown): Promise<string | Uint8Array> {
    return this.#store.readFile(path.join(this.root, relPath), options);
  }

  /**
   * Get the file metadata such as size and modification time.
   * @param relPath - The file path relative to the object root.
   */
  async stat(relPath: string) {
    return this.#store.stat(path.join(this.root, relPath));
  }

  toString() {
    return `OcflObject { root: ${this.root}, id: ${this.id} }`;
  }

  toJSON() {
    return { root: this.root, id: this.id };
  }
}

export { OcflObject };
