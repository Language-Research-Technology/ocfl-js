//@ts-check
"use strict";

const c = require('./constants').OcflConstants;
const validation = require('./validation.js');
const { Enum } = require('./enum.js');
const { OcflObjectInventory, OcflObjectInventoryMut } = require('./inventory.js');
const { OcflDigest } = require('./digest.js');
const path = require('path');
const { pipeline } = require('stream/promises');
const { createTransactionProxy, OcflObjectTransaction, OcflObjectTransactionImpl } = require('./transaction.js');
const { NotImplementedError } = require('./error.js');
const { parallelize, dataSourceAsIterable } = require('./utils');
const { fstat } = require('fs');
const { OcflExtension } = require('./index.js');


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
 */
/**
 * @typedef {Object} OcflObjectConfigEx
 * @property {OcflExtension[]} [extensions] - Reference to existing extensions defined outside of the object, such as in the storage root.
 */
/**
 * @typedef {OcflObjectConfig|OcflObjectConfigEx} OcflObjectConfig2
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
  ocflVersion: c.OCFL_VERSION
};

/**
 * Interface class representing OCFL Object
 * @interface
 */
class OcflObject {
  // static Inventory = OcflObjectInventory;
  // static Transaction = OcflObjectTransaction;
  // static TransactionImpl = OcflObjectTransactionImpl;
  static UPDATE_MODE = UPDATE_MODE;
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

  /**
   * Create a new OCFL Object
   * @abstract
   * @constructor
   * @param {OcflObjectConfig & OcflObjectConfigEx} config
   */
  constructor(config) {
    super();
    if (this.constructor === OcflObjectImpl) {
      throw new TypeError('Abstract class "OcflObjectImpl" cannot be instantiated directly.');
    }
    if (!config.root) throw new Error('[OcflObject] config.root is required.');
    if (config.root === config.workspace) throw new Error('[OcflObject] config.root and config.workspace must be different.');
    this.#root = path.resolve(config.root);
    this.ocflVersion = config.ocflVersion || c.OCFL_VERSION;
    //this.contentVersion = null; // No content yet
    this.#id = config.id;
    this.#extensions = config.extensions;
    this.versions = null;
    this.digestAlgorithm = DIGEST.of(config.digestAlgorithm || 'sha512');
    if (!this.digestAlgorithm) throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    //this.namaste = c.NAMASTE_PREFIX_OBJECT+this.ocflVersion;
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
    let invPath = version === 'latest' ? c.INVENTORY_NAME : path.join(version, c.INVENTORY_NAME);
    let datastr;
    try {
      datastr = /** @type string */(await this._readFile(invPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      //inventory does not exist yet
      return;
    }
    let data = /** @type import('./inventory.js').Inventory */(JSON.parse(datastr));
    let [digest, actualDigest] = /** @type [string,string] */ (await Promise.all([
      this._readFile(invPath + '.' + data.digestAlgorithm, 'utf8'),
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
    let inv = await this.getInventory();
    let newInv = await this._createInventory(inv, mode === UPDATE_MODE.REPLACE);
    let t = await this._createTransaction(newInv);
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

  async _resolveContentPath({ logicalPath = '', contentPath = '', digest = '', version = '' }) {
    if (!contentPath) {
      let inv = await this.getInventory();
      version = version || inv.head;
      contentPath = inv.getContentPath(digest || inv.getDigest(logicalPath, version));
    }
    return contentPath;
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
    if (!p) throw new Error(`Cannot find content "${opt.logicalPath||opt.contentPath||opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version||'latest'}"`);
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
    return this.getAsBuffer({...opt, options: opt.encoding || 'utf8' });
  }

  async getAsStream(opt) {
    let p = await this._resolveContentPath(opt);
    if (!p) throw new Error(`Cannot find content "${opt.logicalPath||opt.contentPath||opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version||'latest'}"`);
    return this._createReadStream(p, opt.options);
  }

  /**
   * Copy all content of this Object to a directory in local filesystem
   * @param {*} targetDir 
   */
  async export(targetDir, version) { }

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
  @typedef {import('fs').OpenMode} OpenMode
  @typedef {import('events').Abortable} Abortable
  @typedef {{ 
    (relPath: string, options?:({encoding?: null | undefined, flag?: OpenMode | undefined} & Abortable) | null): Promise<Buffer>
    (relPath: string, options:({encoding: BufferEncoding, flag?: OpenMode | undefined} & Abortable)|BufferEncoding): Promise<string>
  }} ReadFileFn
   */
  /**
   * Provide a common interface to read a file inside an object. 
   * A concrete subclass MAY implement this method to provide read access to its underlying storage backend.
   * The default implementation uses the {@link OcflObject._createReadStream} method.
   * @method
   * @param {string} relPath - The path of the file to be read relative to the object root.
   * @param {{encoding?:BufferEncoding, flag?:OpenMode} | BufferEncoding} [options]
   */
  async _readFile(relPath, options) {
    let rs = await this._createReadStream(relPath, options);
    let chunks = [];
    for await (const chunk of rs) {
      chunks.push(chunk);
    }
    if (typeof options === 'string' || options.encoding ) {
      return Buffer.concat(chunks);
    } else {
      return chunks.join('');
    }
  }

  /** @type ReadFileFn*/
  readFile = async function(relPath, options) {
    return this._readFile(relPath, options);
  }

  /** @typedef {string|Buffer|NodeJS.ArrayBufferView|AsyncIterable|Iterable|import('stream').Readable} WriteFileData */
  /**
   * Provide a common interface to write a file inside an object. 
   * A concrete subclass MAY implement this method to provide write access to its underlying storage backend.
   * The default implementation uses the {@link OcflObject._createWriteStream} method.
   * @param {string} filePath - Absolute or relative (to the object root) path to the file.
   * @param {WriteFileData} data - The data to be written to the file. 
   * @param {Object|string} options 
   */
  async _writeFile(filePath, data, options) {
    filePath = this.toAbsPath(filePath);
    var source = dataSourceAsIterable(data);
    await this._createDir(path.dirname(filePath));
    const target = await this._createWriteStream(filePath, options);
    await pipeline(source, target);
  }

  /**
   * 
   * @param {string} relPath - File path relative to object root.
   * @param {*} options 
   * @return {Promise<import('fs').ReadStream>}
   */
  async _createReadStream(relPath, options) { throw new Error('Not Implemented'); }

  /**
   * Create a stream that writes data to {@link relPath}. 
   * @param {string} relPath 
   * @param {*} options 
   * @return {Promise<import('fs').WriteStream>}
   */
  async _createWriteStream(relPath, options) { throw new Error('Not Implemented'); }

  /**
   * Create a directory if the storage backend supports it, otherwise do nothing
   * @param {string} filePath
   * @return {Promise<string>}
   */
  async _createDir(filePath) { throw new Error('Not Implemented'); }

  async _copyFile(source, target) {
    await this._writeFile(target, await this._createReadStream(source));
  }

  async _move(source, target) { throw new Error('Not Implemented'); }

  /**
   * Remove a file or directory recursively
   * @param {*} filePath 
   */
  async _remove(filePath) { throw new Error('Not Implemented'); }

  /**
   * 
   * @param {string} filePath 
   * @param {*} options
   * @return {Promise<string[]> }
   */
  async _readDir(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * 
   * @param {*} filePath 
   * @return {Promise<import('fs').Stats>}
   */
  async _stat(filePath) { throw new Error('Not Implemented'); }

  async _exists(filePath) {
    try {
      await this._stat(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a new backend-specific update transaction
   * @param {OcflObjectInventoryMut} inventory
   * @return {Promise<OcflObjectTransaction>}
   */
  async _createTransaction(inventory) {
    // @todo: validate existing object
    // check existing 
    let workspacePath = this.workspace || this.root;
    let workspaceVersionPath = path.join(workspacePath, inventory.head);

    if (await this._exists(workspaceVersionPath)) {
      // workspace dir exists, abort update
      throw new Error('Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt');
    }
    let createdDir = await this._createDir(workspacePath);
    if (!this.workspace) await this._ensureNamaste();
    return createTransactionProxy(new OcflObjectTransactionImpl(this, inventory, workspaceVersionPath, createdDir));
  }

  async _ensureNamaste() {
    let prefix = c.NAMASTE_PREFIX_OBJECT;
    let filenamePrefix = c.NAMASTE_T + prefix;
    try {
      let found = await Promise.any(c.OCFL_VERSIONS.map(async (v) =>
        /**@type {string}*/(await this._readFile(filenamePrefix + v, 'utf8')).trim() === prefix + v));
      if (!found) throw validation.createError(6, this.root);
    } catch (error) {
      if (!error.errors || error.errors.some(e => e.code !== 'ENOENT')) throw error;
    }
    // namaste not found, check if object root is not empty
    try {
      let files = await this._readDir('');
      if (files.length > 0) throw new Error('Cannot create an OCFL Object in a non-empty directory');
    } catch (error) {
    }
    //create the namaste file
    await this._writeFile(filenamePrefix + this.ocflVersion, prefix + this.ocflVersion + '\n', 'utf8');
  }

  async isObject(aPath) { }
  async importDir(id, sourceDir) { }
  async load(path) {
    //await this.loadExtensions();
  }
  getVersionString(i) { }
  async determineVersion() { }
  nameVersion(version) {
    return 'ocfl_object_' + version;
  }
  async digest_dir(dir) { }
  async hash_file(p) { }
  async removeEmptyDirectories(folder) { }
  async inventory(id, dir) { }
  async getFilePath(filePath, version) { }
  resolveFilePath(filePath) { }
  async diffVersions(prev, next) { }
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
