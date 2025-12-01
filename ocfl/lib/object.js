//@ts-check
"use strict";

const path = require('path');
const validation = require('./validation.js');
const { enumeration } = require('./enum.js');
const { OcflObjectInventory, OcflObjectInventoryMut, VersionNumber } = require('./inventory.js');
const { OcflDigest } = require('./digest.js');
const { OcflObjectTransaction, OcflObjectTransactionImpl } = require('./transaction.js');
const { OcflStore } = require('./store.js');
const { OcflExtension } = require('./extension.js');
const { NotImplementedError } = require('./error.js');
const { parallelize, isDirEmpty, findNamasteVersion } = require('./utils');
const { OcflObjectFile } = require('./file.js');
const { OCFL_VERSION, OCFL_VERSIONS, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = require('./constants').OcflConstants;

const UPDATE_MODES = /** @type { const } */(['MERGE', 'REPLACE']);
const UPDATE_MODE = enumeration(UPDATE_MODES);
const DIGEST = OcflDigest.CONTENT;

/**
 * @typedef {(typeof UPDATE_MODES)[number]} UpdateModeStr
 * @typedef { InstanceType<typeof UPDATE_MODE> | UpdateModeStr} UpdateMode
 * @typedef {string} LogicalPath
 * @typedef {{logicalPath: string, version?: string}} FileRefLogical
 * @typedef {{digest: string, version?: string}} FileRefDigest
 * @typedef {{contentPath: string, version?: string}} FileRefContent
 * 
 */

/**
 * @typedef {Object} OcflObjectConfig
 * @property {string} root - Absolute path to the ocfl object root.
 * @property {string} [workspace] - Absolute path to object workspace directory.
 * @property {('sha256' | 'sha512')} [digestAlgorithm] - Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'.
 * @property {string} [id] - Identifier for the object.  Only be used in a newly created object.
 * @property {string} [contentDirectory='content'] - Content directory name. Only applies to a newly created object.
 * @property {OcflVersion} [ocflVersion=c.OCFL_VERSION] - Ocfl version. Only applies to a newly created object.
 * @property {OcflExtension[]} [extensions] - Reference to existing extensions defined outside of the object, such as in the storage root.
 * @property {string[]} [fixityAlgorithms] - Additional digest algorithms to be calculated for each file and added to the fixity block.
 */

/**
 * A class representing an OCFL Object allowing to read and write the content of an OCFL Object in the underlying store.
 */
class OcflObject {

  /** @type {OcflVersion} */
  #ocflVersion;
  /** @type {string} */
  #root;
  /** @type {string} */
  #workspace;
  /** @type {string} */
  #id;
  /** @type {('sha256' | 'sha512')} */
  #digestAlgorithm;
  /** @type {OcflExtension[]} */
  #extensions;
  /** @type {OcflStore} */
  #store;
  /** 
   * A default list of digest algorithms to be calculated for each file in this object and added to the fixity block.
   * @type {string[]} 
   */
  fixityAlgorithms;

  /**
   * Create a new OCFL Object
   * @param {OcflObjectConfig} config
   * @param {OcflStore} store
   */
  constructor(config, store) {
    if (!store) throw new TypeError('[OcflObject] store is required.');
    this.#store = store;
    if (!config.root) throw new TypeError('[OcflObject] config.root is required.');
    if (config.root === config.workspace) throw new Error('[OcflObject] config.root and config.workspace must be different.');
    this.#root = path.resolve(config.root);
    this.#ocflVersion = config.ocflVersion || /** @type {OcflVersion} */(OCFL_VERSION);
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    this.#extensions = config.extensions;
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.digestAlgorithm = config.digestAlgorithm || 'sha512';
    this.#workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.contentDirectory = config.contentDirectory ?? 'content';
    /** @type Object.<string, OcflObjectInventory> */
    this._inventory = {};
    this.fixityAlgorithms = config.fixityAlgorithms;
  }

  /** the digest algorithm used to identify files within the OCFL object */
  get digestAlgorithm() { return this.#digestAlgorithm; }
  set digestAlgorithm(algorithm) {
    this.#digestAlgorithm = algorithm;
    // @ts-ignore
    this.#digestAlgorithm = enumeration.of(DIGEST, algorithm || 'sha512')?.name;
    if (!this.#digestAlgorithm) throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
  }

  /** 
  * Identifier of the OCFL Object
  * @return {string} 
  */
  get id() { return this.inventory?.id || this.#id; }

  /** 
  * Latest version number of the OCFL Object
  * @return {VersionNumber} 
  */
  get headVersion() {
    const head = this.inventory?.head;
    if (head) return VersionNumber.fromString(head);
  }

  /** 
  * All available version numbers in the OCFL Object
  * @return {VersionNumber[]} 
  */
  get versions() {
    return Object.keys(this.inventory?.versions || {}).map(v => VersionNumber.fromString(v));
  }

  /** 
  * The absolute path to the root of this OCFL Object
  * @return {string} 
  */
  get root() { return this.#root; }

  /** 
  * The absolute path to the temporary workspace of this OCFL Object
  * @return {string} 
  */
  get workspace() { return this.#workspace; }

  /** The raw OCFL version number the object adheres to , eg 1.0, 1.1) */
  get ocflVersion() { return this.#ocflVersion; }

  /**
   * Create a new backend-specific update transaction
   * @param {OcflObjectInventoryMut} inventory
   * @return {Promise<OcflObjectTransaction>}
   */
  async #createTransaction(inventory) {
    await this._validateObjectPath();
    if (!this.workspace) await this._ensureNamaste();
    let workspacePath = this.workspace || this.root;
    return OcflObjectTransactionImpl.create(this, this.#store, inventory, workspacePath);
  }

  async _ensureNamaste() {
    let prefix = NAMASTE_PREFIX_OBJECT;
    let nv = await findNamasteVersion(this.#store, prefix, this.root);
    if (nv === '') throw validation.createError(6, this.root);
    if (nv) {
      if (!this.ocflVersion) this.#ocflVersion = /** @type {OcflVersion} */(nv);
      return;
    }
    // namaste not found, check if object root is not empty
    let files;
    try {
      files = await this.#store.readdir(this.root);
    } catch (error) {
    }
    if (files && files.length > 0) throw new Error('Cannot create an OCFL Object in a non-empty directory');
    //create the namaste file
    let filePath = path.join(this.root, NAMASTE_T + prefix + this.ocflVersion);
    await this.#store.writeFile(filePath, prefix + this.ocflVersion + '\n', 'utf8');
  }

  /**
   * Read and parse the inventory.json file
   * @param {string} [version] - Full name of the version, eg: v1, v2, v3 
   * @returns {Promise<OcflObjectInventory>}
   */
  async _readInventory(version = 'latest') {
    let invPath = version === 'latest' ? INVENTORY_NAME : path.join(version, INVENTORY_NAME);
    let datastr;
    try {
      datastr = /** @type string */(await this.readFile(invPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      //inventory does not exist yet
      return;
    }
    let data = /** @type Inventory */(JSON.parse(datastr));
    let [digest, actualDigest] = /** @type [string,string] */ (await Promise.all([
      this.readFile(invPath + '.' + data.digestAlgorithm, 'utf8'),
      OcflDigest.digest(data.digestAlgorithm, datastr)
    ]));
    digest = digest.match(/[^\s]+/)?.[0];
    if (digest !== actualDigest) throw new Error(`Inventory file ${this.root}/${invPath} digest mismatch: recorded=${digest} actual=${actualDigest}`);
    //return new OcflObjectInventory({ data, digest });
    return new OcflObjectInventory(data);
  }

  /**
   * Set the latest version of inventory in the cache
   * @param {*} inventory 
   * @param {*} version 
   */
  _setInventory(inventory, version='latest') {
    //this._inventory['latest'] = this._inventory[inventory.head] = inventory;
    this._inventory[version] = inventory;
    if (version === 'latest') this._inventory[inventory.head] = inventory;
  }

  // all the parent directories cannot be an ocfl object
  async _validateObjectPath() {
    var p = this.root;
    while (p !== '.' && p !== '/') {
      p = path.dirname(p);
      let nv = await findNamasteVersion(this.#store, NAMASTE_PREFIX_OBJECT, p);
      if (nv) throw new Error(`Object root cannot be nested under another object ${p}`);
    }
  }

  /**
   * If a cache exists, return the cached inventory. Otherwise read it from the storage and cache it.
   * If the inventory file does not exist, eg in a newly created object, returns undefined. 
   * @param {string} [version] - Full name of the version, eg: v1, v2, v3  
   * @returns {Promise<OcflObjectInventory>}
   */
  async getInventory(version = 'latest') {
    if (!this._inventory[version]) {
      let inv = await this._readInventory(version);
      if (inv) this._setInventory(inv, version);
    }
    return this._inventory[version];
  }

  _baseInventory() {
    return {
      id: this.id,
      digestAlgorithm: this.digestAlgorithm || 'sha512',
      type: /** @type {Inventory["type"]} */(`https://ocfl.io/${this.ocflVersion}/spec/#inventory`),
      contentDirectory: this.contentDirectory || 'content'
    };
  }

  /**
   * Update the content files or directories as one transaction and commit the changes as a new version.
   * After obtaining the OcflObjectTransaction instance, make sure to either call the
   * {@link OcflObjectTransaction#commit} or {@link OcflObjectTransaction#rollback} method to complete the transaction.
   * If callback function `cb` is provided, all update operations can be done in the callback function
   * and all changes are automatically commited at the end of the function.
   * @param {function(OcflObjectTransaction):Promise<*>} [updater]
   * @param {UpdateMode} [mode_]
   * @return {Promise<?OcflObjectTransaction>}
   */
  async update(updater, mode_ = UPDATE_MODE.MERGE) {
    const mode = enumeration.of(UPDATE_MODE, mode_);
    if (!mode) throw new TypeError(`Invalid mode '${mode.toString()}'`);
    const inv = await this.getInventory() ?? this._baseInventory();
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
   * @param {string|string[]|string[][]} content - The source path(s) or an array of a tuple [source, logical path]
   * @param {UpdateMode} [mode=UPDATE_MODE.MERGE] - Update mode.
   */
  async import(content, mode = UPDATE_MODE.MERGE) {
    //let entries = /**@type {string[][]}*/(content);
    if (typeof content === 'string') content = [[content, '']];
    //else if (typeof content[0] === 'string') entries = /**@type {string[]}*/(content).map(src => [src, '']);

    await this.update(async (t) => {
      let res = await parallelize(/**@type {string[][]}*/(content), async (p) => {
        if (typeof p === 'string') p = [p, ''];
        let [source, target] = p;
        return t.import(source, target);
      });
      let errors = [];
      for (let i = 0; i < res.length; ++i) {
        if (res[i] instanceof Error) errors.push(content[i][0]);
      }
      if (errors.length) {
        let msg = "Cannot add the files: " + errors.join(', ');
        throw new Error(msg);
      }
    }, mode);
  }

  /**
   * Alias for import
   * @see {@link OcflObject.import}
   */
  async add(sourceDir, mode = UPDATE_MODE.MERGE) {
    await this.import(sourceDir, mode);
  }

  /**
   * Count the number of files contained in this object
   * @param {string} [version]
   */
  async count(version) {
    let inv = await this.getInventory();
    return [...inv.files(version)].length;
  }

  async createReadable(filePath, options) {
    return this.#store.createReadable(path.join(this.root, filePath), options);
  }

  /**
   * Check if the object root path points to an existing file or non-empty directory
   * in the underlying backend store.
   * The existing directory may or may not be a valid OCFL Object.
   * @return {Promise<boolean>}
   */
  async exists() {
    return !(await isDirEmpty(this.#store, this.root));
  }

  /**
   * Copy all content of this Object to a directory in local filesystem
   * @param {string} targetDir 
   * @param {string} version 
   */
  async export(targetDir, version) { throw new Error('Not Implemented'); }

  /**
   * Iterate through the content files contained in the specified version. 
   * Returns an Iterator that contains FileRef which consists of logical path, content path, and digest, in no particular order.
   * The iterator is implemented as a generator.
   * @param {string} [version]
   * @return {Promise<Generator<OcflObjectFile, void, unknown>>}
   */
  async files(version) {
    let inv = await this.getInventory();
    let o = this;
    function* files() {
      for (const f of inv.files(version)) {
        yield new OcflObjectFile(o, f);
      }
    }
    return files();
  }

  /**
   * Get a file by either the [logical path and version], digest, or content path.
   * If version is omitted, it defaults to the last version.
   * @param { LogicalPath | FileRefLogical | FileRefDigest | FileRefContent } opt A choice of logical path (eg: 'test') and version (eg: 'v1'), 
   * digest of the file content, or content path (eg: 'v1/content/test')
   * @param {string} [version='latest'] The object version name, eg: 'v1', 'v2'. Default to 'latest'. Only used if opt is a LogicalPath.
   * @returns {OcflObjectFile}
   */
  getFile(opt, version) {
    const inv = this.inventory;
    /** @type {any} */
    let file = typeof opt === 'string' ? { logicalPath: opt, version: version } : { ...opt };
    if (file.logicalPath) {
      file = inv?.getFile(file.logicalPath, file.version);
    } else if (file.digest) {
      file = inv?.getFileByDigest(file.digest, file.version);
    } else if (file.contentPath) {
      file = inv?.getFileByContentPath(file.contentPath, file.version);
    }
    if (file) return new OcflObjectFile(this, file);
  };

  /**
   * Return the latest version of the cached data from inventory.json which can be read using {@link getInventory()}
   */
  get inventory() {
    return this._inventory.latest;
  }

  /** 
   * Reads the object inventory file and cache it in the memory.
   * Optionally, preloads and reads all files metadata from the underlying storage.
   * @param {object} [options]
   * @param {boolean} [options.filesMetadata] Whether to read file metadata from the underlying storage.
   */
  async load({ filesMetadata } = {}) {
    this._inventory = {}; // reset inventory cache
    const inv = await this.getInventory();
    //await this.loadExtensions();
    if (inv && filesMetadata) {
      //load file metadata from underlying storage
      const metadata = inv.metadata = {};
      for await (const file of await this.#store.list(this.root, { recursive: true })) {
        const contentPath = file.path;
        metadata[contentPath] = {
          size: file.size,
          lastModified: file.lastModified.getTime()
        }
      }
    }
  }

  /** 
   * Read the content of a file inside an object.
   * @param {string} relPath - The file path relative to the object root.
   * @param {*} options - Options to be passed to the underlying method
   */
  async readFile(relPath, options) {
    return this.#store.readFile(path.join(this.root, relPath), options);
  };

  toString() { return `OcflObject { root: ${this.root}, id: ${this.id} }`; }

  toJSON() { return { root: this.root, id: this.id }; }


}


/**
 * @implements {OcflObject}
 */
class OcflObjectImpl extends OcflObject {


  /** 
  @typedef {import('fs').OpenMode} OpenMode
  @typedef {import('events').Abortable} Abortable
  @typedef {{ 
    (relPath: string, options?:({encoding?: null | undefined, flag?: OpenMode | undefined} & Abortable) | null): Promise<Buffer>
    (relPath: string, options:({encoding: BufferEncoding, flag?: OpenMode | undefined} & Abortable)|BufferEncoding): Promise<string>
  }} ReadFileFn
   */


  // async _resolveContentPath({ logicalPath = '', contentPath = '', digest = '', version = '' }) {
  //   if (!contentPath) {
  //     let inv = await this.getInventory();
  //     version = version && version !== 'latest' ? version : inv.head;
  //     contentPath = inv.getContentPath(digest || inv.getDigest(logicalPath, version));
  //   }
  //   return contentPath;
  // }

  async isObject(aPath) { }
  static status(rootPath) { }
  static exists(rootPath) { }

  /**
   * Validate this object
   * @abstract
   */
  async validate() { throw new Error('Not Implemented'); }
  async verify() { return this.validate(); }

};


module.exports = {
  OcflObject,
  OcflObjectInventory,
  //OcflObjectTransaction,
  OcflObjectTransactionImpl
};
