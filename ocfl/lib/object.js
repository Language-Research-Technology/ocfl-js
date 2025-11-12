//@ts-check
"use strict";

const path = require('path');
const validation = require('./validation.js');
const { enumeration } = require('./enum.js');
const { OcflObjectInventory, OcflObjectInventoryMut } = require('./inventory.js');
const { OcflDigest } = require('./digest.js');
const { OcflObjectTransaction, OcflObjectTransactionImpl } = require('./transaction.js');
const { OcflStore } = require('./store.js');
const { OcflExtension } = require('./extension.js');
const { NotImplementedError } = require('./error.js');
const { parallelize, isDirEmpty, findNamasteVersion } = require('./utils');
const { OCFL_VERSION, OCFL_VERSIONS, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = require('./constants').OcflConstants;

const UPDATE_MODES = /** @type { const } */(['MERGE', 'REPLACE']);
const UPDATE_MODE = enumeration(UPDATE_MODES);
const DIGEST = OcflDigest.CONTENT;

/** @typedef {(typeof UPDATE_MODES)[number]} UpdateModeStr **/
/** @typedef { InstanceType<typeof UPDATE_MODE> | UpdateModeStr} UpdateMode **/

/**
 * @typedef {Object} OcflObjectConfig
 * @property {string} root - Absolute path to the ocfl object root.
 * @property {string} [workspace] - Absolute path to object workspace directory.
 * @property {('sha256' | 'sha512')} [digestAlgorithm] - Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'.
 * @property {string} [id] - Identifier for the object.  Only be used in a newly created object.
 * @property {string} [contentDirectory='content'] - Content directory name. Only applies to a newly created object.
 * @property {string} [ocflVersion=c.OCFL_VERSION] - Ocfl version. Only applies to a newly created object.
 * @property {OcflExtension[]} [extensions] - Reference to existing extensions defined outside of the object, such as in the storage root.
 */
/**
 * @typedef {Object} FileRef
 * @property {string} [contentPath] - Actual path to the file location relative to the ocfl object root.
 * @property {string} [logicalPath] - A path that represents a file’s location in the logical state of an object.
 * @property {string} [digest] - An algorithmic characterization of the contents of a file conforming to a standard digest algorithm.
 * @property {string} [version] - Version of the OCFL object.
 * @property {string} [lastModified] - Last modified date of the file.
 * @property {string} [size] - Size of the file in bytes.
 * @typedef {{logicalPath: string, version?: string}} FileRefLogical
 * @typedef {{digest: string}} FileRefDigest
 * @typedef {{contentPath: string}} FileRefContent
 */

/**
 * Represent a file in an OCFL object
 */
class OcflObjectFile {
  #ocflObject;
  #lastModified;
  #size;

  /**
   * 
   * @param {OcflObjectImpl} ocflObject 
   * @param {FileRef} fileRef 
   */
  constructor(ocflObject, fileRef) {
    this.#ocflObject = ocflObject;
    // for (const key in ['logicalPath', 'version', 'digest', 'contentPath']) {
    //   if (fileRef[key]) this[key] = fileRef[key];
    // }
    if (fileRef.logicalPath) this.logicalPath = fileRef.logicalPath;
    if (fileRef.contentPath) this.contentPath = fileRef.contentPath;
    if (fileRef.digest) this.digest = fileRef.digest;
    if (fileRef.version) this.version = fileRef.version;
    if (fileRef.lastModified != null) this.#lastModified = fileRef.lastModified;
    if (fileRef.size != null) this.#size = fileRef.size;
  }

  /**
   * Resolve contentPath given either the `logicalPath` and `version`, `digest`, or `contentPath`.
   */
  async #resolveContentPath() {
    let contentPath = this.contentPath;
    if (!contentPath) {
      let inv = await this.#ocflObject.getInventory();
      if (!inv) throw new Error(`OCFL Object "${this.#ocflObject.id}" does not exist`);
      let version = !this.version || this.version === 'latest' ? inv.head : this.version;
      let digest = this.digest || inv.getDigest(this.logicalPath, version);
      contentPath = inv.getContentPath(digest);
      if (!contentPath) throw new Error(`Cannot find content "${this.toString()}" in the OCFL Object "${this.#ocflObject.id}" version "${this.version || 'latest'}"`);
    }
    return contentPath;
  }

  /**
   * Returns the last modified time of the file, in millisecond since the UNIX epoch (January 1st, 1970 at Midnight).
   */
  get lastModified() { return this.#lastModified  }
  
  /**
   * Returns the file size in bytes.
   */
  get size() { return this.#size }

  toString() {
    let props = [];
    for (const key in ['logicalPath', 'version', 'digest', 'contentPath']) {
      if (this[key]) props.push(key + ": '" + this[key] + "'");
    }
    return `{ ${props.join(', ')} }`;
  }

  /**
   * Get the file content as a buffer
   * @param {*} [options] Options to be passed to underlying data store specific implementation

   * @return {Promise<Buffer>}
   */
  async buffer(options) {
    return this.#ocflObject.readFile(await this.#resolveContentPath(), options);
  }
  /**
   * @deprecated
   */
  async asBuffer(options) {
    return this.buffer(options);
  }

  /**
   * Get the file content as a string
   * @param {BufferEncoding} [encoding='utf8'] String encoding, default to utf8
   * @return {Promise<string>}
   */
  async text(encoding = 'utf8') {
    // @ts-ignore
    return this.buffer(encoding);
  }
  /**
   * @deprecated
   */
  async asString(encoding = 'utf8') {
    // @ts-ignore
    return this.text(encoding);
  }

  /**
   * Get the file content as a NodeJS stream
   * @param {*} [options] Options to be passed to underlying data store specific implementation
   * @return {Promise<NodeJS.ReadableStream>}
   * @deprecated
   */
  async asStream(options) {
    return this.#ocflObject.createReadStream(await this.#resolveContentPath(), options);
  }

  /**
   * Get the file content as a ES Streams standard ReadableStream
   * @param {*} [options] Options to be passed to underlying data store specific implementation
   * @return {Promise<ReadableStream>}
   */
  async stream(options) {
    return this.#ocflObject.createReadable(await this.#resolveContentPath(), options);
  }
}


/**
 * Interface class representing OCFL Object
 * @interface
 */
class OcflObject {

  /** 
   * Identifier of the OCFL Object
   * @return {string} 
   */
  get id() { throw new NotImplementedError(); }

  /** 
  * The absolute path to the root of this OCFL Object
  * @return {string} 
  */
  get root() { throw new NotImplementedError(); }

  /** 
  * The absolute path to the temporary workspace of this OCFL Object
  * @return {string} 
  */
  get workspace() { throw new NotImplementedError(); }

  toString() { return `OcflObject { root: ${this.root}, id: ${this.id} }`; }

  toJSON() { return { root: this.root, id: this.id }; }

  /**
   * If a cache exists, return the cached inventory. Otherwise read it from the storage and cache it.
   * @param {string} [version] - Full name of the version, eg: v1, v2, v3  
   * @returns {Promise<OcflObjectInventory>}
   */
  async getInventory(version = 'latest') { throw new NotImplementedError(); }

  /**
   * Update the content files or directories as one transaction and commit the changes as a new version.
   * After obtaining the OcflObjectTransaction instance, make sure to either call the
   * {@link OcflObjectTransaction#commit} or {@link OcflObjectTransaction#rollback} method to complete the transaction.
   * If callback function `cb` is provided, all update operations can be done in the callback function
   * and all changes are automatically commited at the end of the function.
   * @param {function(OcflObjectTransaction):*} [updater]
   * @param {UpdateMode} [mode=UPDATE_MODE.MERGE]
   * @return {Promise<?OcflObjectTransaction>}
   */
  async update(updater, mode) { throw new NotImplementedError(); }

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

  async load() { throw new NotImplementedError(); }

  /**
   * Iterate through the content files contained in the specified version. 
   * Returns an Iterator that contains FileRef which consists of logical path, content path, and digest, in no particular order.
   * The iterator is implemented as a generator.
   * @param {string} [version]
   * @return {Promise<Generator<OcflObjectFile, void, unknown>>}
   */
  async files(version) { throw new Error('Not Implemented'); }

  /**
   * Get a file by its logical path and version. If version is omitted, it defaults to the last version.
   * @callback GetFileByLogical 
   * @param {string} logicalPath Logical path of the file, eg: 'test'
   * @param {string} [version='latest'] The object version name, eg: 'v1', 'v2'. Default to 'latest'
   * @returns {OcflObjectFile}
   */
  /**
   * Get a file by either the [logical path and version], digest, or content path.
   * @callback GetFileByOpt
   * @param { FileRefLogical | FileRefDigest | FileRefContent } opt A choice of logical path (eg: 'test') and version (eg: 'v1'), 
   * digest of the file content, or content path (eg: 'v1/content/test')
   * @returns {OcflObjectFile}
   */
  /**
   * Retrieve the content of a file either as string, buffer, or stream.
   * @type { GetFileByLogical & GetFileByOpt }
   */
  // @ts-ignore
  getFile = function (opt, version) { };

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

  //async inventory(version = 'latest') { }

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
  #workspace;
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
    this.digestAlgorithm = enumeration.of(DIGEST, config.digestAlgorithm || 'sha512');
    if (!this.digestAlgorithm) throw new Error('Invalid digest algorithm. Must be one of `sha256` or `sha512`.');
    //this.fixityDigest = config.fixityDigest ?? this.digestAlgorithm;
    this.#workspace = config.workspace ? path.resolve(config.workspace) : undefined;
    this.contentDirectory = config.contentDirectory ?? 'content';
    /** @type Object.<string, OcflObjectInventory> */
    this._inventory = {};
  }
  get id() { return this._inventory?.latest?.id || this.#id; }
  get root() { return this.#root; }
  get workspace() { return this.#workspace; }

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
    let data = /** @type Inventory */(JSON.parse(datastr));
    let [digest, actualDigest] = /** @type [string,string] */ (await Promise.all([
      this.readFile(invPath + '.' + data.digestAlgorithm, 'utf8'),
      OcflDigest.digestAsync(data.digestAlgorithm, datastr)
    ]));
    digest = digest.match(/[^\s]+/)?.[0];
    if (digest !== actualDigest) throw new Error(`Inventory file ${this.root}/${invPath} digest mismatch: recorded=${digest} actual=${actualDigest}`);
    //return new OcflObjectInventory({ data, digest });
    return new OcflObjectInventory(data);
  }

  async load() {
    this._inventory = {};
    const inv = await this.getInventory();
    //await this.loadExtensions();

    //load file metadata from underlying storage
    const metadata = inv.metadata = {};
    for await (const file of await this.#store.list(this.root, { recursive: true })) {
      const contentPath = file.path;
      metadata[contentPath] = {
        size: file.size,
        lastModified: file.lastModified.getTime()
      }
    }
    return;
  }

  /**
   * @param {function(OcflObjectTransaction):Promise<*>} [updater]
   * @param {UpdateMode} [mode_=UPDATE_MODE.MERGE]
   */
  async update(updater, mode_ = UPDATE_MODE.MERGE) {
    let mode = enumeration.of(UPDATE_MODE, mode_);
    if (!mode) throw new TypeError(`Invalid mode '${mode.toString()}'`);
    let inv = await this.getInventory();
    let newInv = await OcflObjectInventory.newVersion(inv ?? {
      id: this.id,
      digestAlgorithm: /** @type {any} */(this.digestAlgorithm.toString()),
      type: /** @type {any} */(`https://ocfl.io/${this.ocflVersion}/spec/#inventory`),
      contentDirectory: this.contentDirectory || 'content'
    }, mode === UPDATE_MODE.REPLACE);
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

  /** @deprecated */
  async createReadStream(filePath, options) {
    return this.#store.createReadStream(path.join(this.root, filePath), options);
  }

  async createReadable(filePath, options) {
    return this.#store.createReadable(path.join(this.root, filePath), options);
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
   * @type {ReadFileFn} abc
   * @param {string} relPath - The file path relative to the object root.
   * @param options - Options to be passed to the underlying method
   */
  readFile = async function (relPath, options) {
    return this.#store.readFile(path.join(this.root, relPath), options);
  };

  getFile = function (opt, version) {
    var obj = this;
    var opt_ = typeof opt === 'string' ? { logicalPath: opt, version: version } : opt;
    return new OcflObjectFile(this, opt_);
  };

  // async _resolveContentPath({ logicalPath = '', contentPath = '', digest = '', version = '' }) {
  //   if (!contentPath) {
  //     let inv = await this.getInventory();
  //     version = version && version !== 'latest' ? version : inv.head;
  //     contentPath = inv.getContentPath(digest || inv.getDigest(logicalPath, version));
  //   }
  //   return contentPath;
  // }

  // async getAsBuffer(opt) {
  //   let p = await this._resolveContentPath(opt);
  //   if (!p) throw new Error(`Cannot find content "${opt.logicalPath || opt.contentPath || opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version || 'latest'}"`);
  //   return this.readFile(p, opt.options);
  // }
  // async getAsString(opt) {
  //   // @ts-ignore
  //   return this.getAsBuffer({ ...opt, options: opt.encoding || 'utf8' });
  // }
  // async getAsStream(opt) {
  //   let p = await this._resolveContentPath(opt);
  //   if (!p) throw new Error(`Cannot find content "${opt.logicalPath || opt.contentPath || opt.digest}" in the OCFL Object "${this.#id}" version "${opt.version || 'latest'}"`);
  //   return this.createReadStream(p, opt.options);
  // }

  /**
   * Copy all content of this Object to a directory in local filesystem
   * @param {*} targetDir 
   */
  async export(targetDir, version) { }

  async exists() {
    return !(await isDirEmpty(this.#store, this.root));
  }

  /**
   * @param {string} [version]
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
      if (!this.ocflVersion) this.ocflVersion = nv;
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

  // all the parent directories cannot be an ocfl object
  async _validateObjectPath() {
    var p = this.root;
    while (p !== '.' && p !== '/' ) {
      p = path.dirname(p);
      let nv = await findNamasteVersion(this.#store, NAMASTE_PREFIX_OBJECT, p);
      if (nv) throw new Error(`Object root cannot be nested under another object ${p}`);
    }
  }
  
  async isObject(aPath) { }
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
};

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
  createObjectProxy,
  createObject
};
