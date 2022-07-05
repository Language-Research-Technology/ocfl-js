//@ts-check
"use strict";

const path = require('path');
const validation = require('./validation.js');
const { Enum } = require('./enum.js');
const { OcflObjectInventory, OcflObjectInventoryMut } = require('./inventory.js');
const { OcflDigest } = require('./digest.js');
const { createTransactionProxy, OcflObjectTransaction, OcflObjectTransactionImpl } = require('./transaction.js');
const { OcflStore } = require('./store.js');
const { OcflExtension } = require('./extension.js');
const { NotImplementedError } = require('./error.js');
const { parallelize, dataSourceAsIterable, isDirEmpty, findNamasteVersion } = require('./utils');
const { OCFL_VERSION, OCFL_VERSIONS, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = require('./constants').OcflConstants;

class UPDATE_MODE extends Enum {
  /** Merge all changes with the last version during update */
  static MERGE = new this();
  /** New version will assume that all existing files are removed first before adding new ones */
  static REPLACE = new this();
};
const DIGEST = OcflDigest.CONTENT;

/**
 * @typedef {Object} OcflObjectConfig
 * @property {string} root - Absolute path to the ocfl object root
 * @property {string} [workspace] - Absolute path to object workspace directory
 * @property {('sha256' | 'sha512')} [digestAlgorithm] - Digest algorithm for content-addressing, must use either sha512 or sha256
 * @property {string} [id] - Identifier for the object.  Only be used in a newly created object.
 * @property {string} [contentDirectory='content'] - Content directory name. Only applies to a newly created object.
 * @property {string} [ocflVersion=c.OCFL_VERSION] - Ocfl version. Only applies to a newly created object.
 * @property {OcflExtension[]} [extensions] - Reference to existing extensions defined outside of the object, such as in the storage root.
 */
/**
 * @typedef {{logicalPath: string; digest: string; contentPath: string;}} FileRef
 */
/**
 * @typedef {UPDATE_MODE | ('MERGE' | 'REPLACE') } ObjectUpdateMode
 */
/**
 *
 */
const defaultConfig = {
  ocflVersion: OCFL_VERSION
};

/**
 * Interface class representing OCFL Object
 * @interface
 */
class OcflObject {

  /** 
   * Identifier of the OCFL Object
   * @return {string} 
   */
  get id() { throw new NotImplementedError() }

  /** 
  * The non-storage specific absolute path to the root of this OCFL Object
  * @return {string} 
  */
  get root() { throw new NotImplementedError() }

  toString() { return `OcflObject { root: ${this.root}, id: ${this.id} }`; }

  toJSON() { return { root: this.root, id: this.id }; }

  async inventory(id, dir) { }

  /**
   * If a cache exists, return the cached inventory. Otherwise read it from the storage and cache it.
   * @param {string} [version] - Full name of the version, eg: v1, v2, v3  
   * @returns {Promise<OcflObjectInventory>}
   */
  async getInventory(version = 'latest') { throw new NotImplementedError() }

  /**
   * Update the content files or directories as one transaction and commit the changes as a new version.
   * If callback function `cb` is provided, all update operations can be done in the callback function
   * and all changes are automatically commited at the end of the function.
   * @param {function(OcflObjectTransaction):*} [updater]
   * @param {ObjectUpdateMode} [mode=UPDATE_MODE.MERGE]
   * @return {Promise<?OcflObjectTransaction>}
   */
  async update(updater, mode = UPDATE_MODE.MERGE) { throw new NotImplementedError() }

  /**
   * Add one or more content files or directories to the object 
   * in one transaction and commit the changes as a new version. 
   * @param {string|string[]|string[][]} content - The path to source or an array of a tuple [source, logical path]
   * @param {ObjectUpdateMode} [mode=UPDATE_MODE.MERGE] - Update mode.
   */
  async add(content, mode = UPDATE_MODE.MERGE) {
    let entries = /**@type {string[][]}*/(content);
    if (typeof content === 'string') entries = [[content, '']];
    else if (typeof content[0] === 'string') entries = [/**@type {string[]}*/(content)];

    await this.update(async (t) => {
      let res = await parallelize(entries, async ([source, target]) => t.copy(source, target));
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
   * Copy all contents of a directory in local filesystem to the OCFL Object content directory
   * @param {string} sourceDir - A directory in which the content will be copied from.
   * @param {ObjectUpdateMode} [mode=UPDATE_MODE.MERGE] - Update mode.
   */
  async import(sourceDir, mode = UPDATE_MODE.MERGE) {
    await this.add(sourceDir, mode);
  }

  async load() {
    await this.getInventory();
    //await this.loadExtensions();
    return;
  }

  /**
   * Iterate through the content files contained in the specified version. 
   * Returns an array of logical paths in no particular order
   * @param {string} [version]
   * @return {Promise<Generator<FileRef, void, unknown>>}
   */
  async files(version) { throw new Error('Not Implemented'); }

  /**
  * Get content file as buffer. Either one of the logicalPath, contentPath, or digest parameters must be specified.
  * @param {Object} opt
  * @param {string} [opt.logicalPath] - Logical path of the file, eg: `test`
  * @param {string} [opt.contentPath] - Content path of the file, eg: `v1/content/test`
  * @param {string} [opt.digest] - Digest of the file content
  * @param {string} [opt.version] - Version name
  * @param {*} [opt.options] - Options to be passed to underlying fs
  * @return {Promise<Buffer>}
  */
  async getAsBuffer(opt) { throw new Error('Not Implemented'); }

  /**
   * Get content file as string
   * @param {Object} opt
   * @param {string} [opt.logicalPath]
   * @param {string} [opt.contentPath] 
   * @param {string} [opt.digest] 
   * @param {string} [opt.version] 
   * @param {BufferEncoding} [opt.encoding] 
   * @return {Promise<string>}
   */
  async getAsString(opt) { throw new Error('Not Implemented'); }

  /**
   * Get content file as a stream. Either one of the logicalPath, contentPath, or digest parameters must be specified.
   * @param {Object} opt
   * @param {string} [opt.logicalPath] - Logical path of the file, eg: `test`
   * @param {string} [opt.contentPath] - Content path of the file, eg: `v1/content/test`
   * @param {string} [opt.digest] - Digest of the file content
   * @param {string} [opt.version] - Version name
   * @param {*} [opt.options] - Options to be passed to underlying fs
   * @return {Promise<NodeJS.ReadableStream>}
   */
  async getAsStream(opt) { throw new Error('Not Implemented'); }

  /**
   * Count the number of files contained in this object
   * @param {string} [version]
   */
  async count(version) {
    return [...await this.files(version)].length;
  }

  /**
   * Check if the object root path points to an existing file or non-empty directory
   * in the underlying backend store.
   * The existing directory may or may not be a valid OCFL Object.
   * @return {Promise<boolean>}
   */
   async exists() { throw new Error('Not Implemented'); }

}


/**
 * Abstract class implementing {@link OcflObject}. 
 * This class provides common functionalities for the subclasses and 
 * at the same provide encapsulation emulating private and protected methods.
 * @implements {OcflObject}
 */
class OcflObjectImpl extends OcflObject {

  /** @type {string} */
  #root;
  /** @type {string} */
  #id;
  /** @type {OcflExtension[]} */
  #extensions;
  /** @type {OcflStore} */
  #store;

  /**
   * Create a new OCFL Object
   * @param {OcflObjectConfig} config
   * @param {OcflStore} store
   */
  constructor(config, store) {
    super();
    if (!store) throw new TypeError('[OcflObject] store is required.');
    this.#store = store;
    if (!config.root) throw new TypeError('[OcflObject] config.root is required.');
    if (config.root === config.workspace) throw new Error('[OcflObject] config.root and config.workspace must be different.');
    this.#root = path.resolve(config.root);
    this.ocflVersion = config.ocflVersion || OCFL_VERSION;
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    this.#extensions = config.extensions;
    this.digestAlgorithm = DIGEST.of(config.digestAlgorithm || 'sha512');
    if (!this.digestAlgorithm) throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.contentDirectory = config.contentDirectory ?? 'content';
    /** @type Object.<string, OcflObjectInventory> */
    this._inventory = {};
  }
  get id() { return this._inventory?.latest?.id || this.#id; }
  get root() { return this.#root; }

  async getInventory(version = 'latest') {
    if (!this._inventory[version]) {
      let inv = await this._readInventory(version);
      if (inv) this._inventory[version] = inv;
    }
    return this._inventory[version];
  }

  _setInventory(inventory) {
    this._inventory['latest'] = this._inventory[inventory.head] = inventory;
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
    let data = /** @type import('./inventory.js').Inventory */(JSON.parse(datastr));
    let [digest, actualDigest] = /** @type [string,string] */ (await Promise.all([
      this.readFile(invPath + '.' + data.digestAlgorithm, 'utf8'),
      OcflDigest.digestAsync(data.digestAlgorithm, datastr)
    ]));
    digest = digest.match(/[^\s]+/)?.[0];
    if (digest !== actualDigest) throw new Error('corrupted file');
    //return new OcflObjectInventory({ data, digest });
    return new OcflObjectInventory(data);
  }

  /**
   * @param {function(OcflObjectTransaction):Promise<*>} [updater]
   * @param {ObjectUpdateMode} [mode=UPDATE_MODE.MERGE]
   */
  async update(updater, mode = UPDATE_MODE.MERGE) {
    if (typeof mode === 'string') mode = UPDATE_MODE.of(mode.toUpperCase());
    if (!mode || !UPDATE_MODE.has(mode)) throw new TypeError(`Invalid mode '${mode.toString()}'`);
    let inv = await this.getInventory();
    let newInv = await this._createInventory(inv, mode === UPDATE_MODE.REPLACE);
    let t = await this.#createTransaction(newInv);
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
   * Return absolute path to the `contentPath` given either the `logicalPath`, `digest` or `contentPath` with a specific version 
   * @param {*} param0 
   * @returns 
   */
  async _resolveContentPath({ logicalPath = '', contentPath = '', digest = '', version = '' }) {
    if (!contentPath) {
      let inv = await this.getInventory();
      version = version || inv.head;
      contentPath = inv.getContentPath(digest || inv.getDigest(logicalPath, version));
    }
    return contentPath;
  }

  /** 
  @typedef {import('fs').OpenMode} OpenMode
  @typedef {import('events').Abortable} Abortable
  @typedef {{ 
    (relPath: string, options?:({encoding?: null | undefined, flag?: OpenMode | undefined} & Abortable) | null): Promise<Buffer>
    (relPath: string, options:({encoding: BufferEncoding, flag?: OpenMode | undefined} & Abortable)|BufferEncoding): Promise<string>
  }} ReadFileFn
   */
  /** 
   * Read a file inside an object. 
   * @param filePath - The file path relative to the object root.
   * @param options - Options to be passed to the underlying method
   * @type ReadFileFn
   */
  readFile = async function (filePath, options) {
    return this.#store.readFile(path.join(this.root, filePath), options);
  }

  /**
   * 
   * @param {Object} opt
   * @param {string} [opt.logicalPath]
   * @param {string} [opt.contentPath] 
   * @param {string} [opt.digest] 
   * @param {string} [opt.version] 
   * @param {*} [opt.options] 
   */
  async getAsBuffer(opt) {
    let p = await this._resolveContentPath(opt);
    if (!p) throw new Error(`Cannot find content "${opt.logicalPath || opt.contentPath || opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version || 'latest'}"`);
    return this.readFile(p, opt.options);
  }

  /**
   * 
   * @param {Object} opt
   * @param {string} [opt.logicalPath]
   * @param {string} [opt.contentPath] 
   * @param {string} [opt.digest] 
   * @param {string} [opt.version] 
   * @param {BufferEncoding} [opt.encoding]
   * @return {Promise<string>} 
   */
  async getAsString(opt) {
    // @ts-ignore
    return this.getAsBuffer({ ...opt, options: opt.encoding || 'utf8' });
  }

  async createReadStream(filePath, options) {
    return this.#store.createReadStream(path.join(this.root, filePath), options);
  }

  async getAsStream(opt) {
    let p = await this._resolveContentPath(opt);
    if (!p) throw new Error(`Cannot find content "${opt.logicalPath || opt.contentPath || opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version || 'latest'}"`);
    return this.#store.createReadStream(p, opt.options);
  }

  /**
   * Copy all content of this Object to a directory in local filesystem
   * @param {*} targetDir 
   */
  async export(targetDir, version) { }

  async exists() {
    return !isDirEmpty(this.#store, this.root);
  }

  /**
   * @param {string} [version]
   */
  async files(version) {
    let inv = await this.getInventory();
    return inv.files(version);
  }


  /**
   * Create a new inventory from the object config or clone an existing inventory.
   * @param {OcflObjectInventory} [inventory]
   * @param {boolean} [cleanState]
   * @return {OcflObjectInventoryMut}
   */
  _createInventory(inventory, cleanState) {
    /** @type {Object} */
    let data;
    if (inventory) {
      data = inventory.toJSON();
    } else {
      data = {
        id: this.id,
        digestAlgorithm: this.digestAlgorithm.value,
        type: `https://ocfl.io/${this.ocflVersion}/spec/#inventory`
      };
      if (this.contentDirectory !== 'content') data.contentDirectory = this.contentDirectory;
    }
    return OcflObjectInventory.newVersion(data, cleanState);
  }

  /**
   * 
   * @param {string} absOrRelPath 
   * @return {string} 
   */
  toAbsPath(absOrRelPath = '') {
    if (!path.isAbsolute(absOrRelPath)) return path.join(this.root, absOrRelPath);
    return absOrRelPath;
  }

  /**
   * Create a new backend-specific update transaction
   * @param {OcflObjectInventoryMut} inventory
   * @return {Promise<OcflObjectTransaction>}
   */
  async #createTransaction(inventory) {
    // @todo: validate existing object
    // check existing 
    let workspacePath = this.workspace || this.root;
    let workspaceVersionPath = path.join(workspacePath, inventory.head);

    if (await this.#store.exists(workspaceVersionPath)) {
      // workspace dir exists, abort update
      throw new Error('Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt');
    }
    let createdDir = await this.#store.mkdir(workspacePath);
    if (!this.workspace) await this._ensureNamaste();
    return createTransactionProxy(new OcflObjectTransactionImpl(this, this.#store, inventory, workspaceVersionPath, createdDir));
  }

  async _ensureNamaste() {
    let prefix = NAMASTE_PREFIX_OBJECT;
    let nv = await findNamasteVersion(this.#store, prefix, this.root);
    if (nv === '') throw validation.createError(6, this.root);
    if (nv) {
      if (!this.ocflVersion) this.ocflVersion = nv;
      return;
    }
    // namaste not found, check if object root is not empty
    try {
      let files = await this.#store.readdir(this.root);
      if (files.length > 0) throw new Error('Cannot create an OCFL Object in a non-empty directory');
    } catch (error) {
    }
    //create the namaste file
    let filePath = path.join(this.root, NAMASTE_T + prefix + this.ocflVersion);
    await this.#store.writeFile(filePath, prefix + this.ocflVersion + '\n', 'utf8');
  }

  async isObject(aPath) { }
  async importDir(id, sourceDir) { }
  getVersionString(i) { }
  async determineVersion() { }
  nameVersion(version) {
    return 'ocfl_object_' + version;
  }
  async digest_dir(dir) { }
  async hash_file(p) { }
  async removeEmptyDirectories(folder) { }
  static status(rootPath) { }
  static exists(rootPath) { }

  /**
   * Validate this object
   * @abstract
   */
  async validate() { throw new Error('Not Implemented'); }
  async verify() { return this.validate(); }

};


const objectInterface = new OcflObject();
const proxyHandler = {
  /**
   * @param {OcflObject} target 
   * @param {string} prop 
   */
  get(target, prop, receiver) {
    if (prop in objectInterface) {
      let p = target[prop];
      if (typeof p === 'function') {
        return p.bind(target);
      } else {
        return p;
      }
    }
  }
}

/**
 * Return any OcflObject implementation as OcflObject.
 * @param {OcflObject} impl
 */
function createObjectProxy(impl) {
  return new Proxy(impl, proxyHandler);
}

/**
 * Create an OCFL Object
 * @param {OcflObjectConfig} config
 * @return {OcflObject}
 */
function createObject(config) {
  throw new Error('Not Implemented');
}

module.exports = {
  OcflObject,
  OcflObjectImpl,
  OcflObjectInventory,
  //OcflObjectTransaction,
  OcflObjectTransactionImpl,
  createTransactionProxy,
  createObjectProxy,
  createObject
};
