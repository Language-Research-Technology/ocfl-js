//@ts-check
//@todo add default layout
const path = require("path");
const validation = require('./validation.js');
const { NotImplementedError } = require("./error");
const { OcflStorageLayout } = require("./extension");
const { HashedNTupleStorageLayout } = require("./extensions/0004-hashed-n-tuple-storage-layout");
const { OcflObject, OcflObjectImpl } = require("./object");
const { isDirEmpty, findNamasteVersion } = require("./utils.js");
const { OCFL_VERSION, OCFL_VERSIONS, OCFL_LAYOUT, 
  EXTENSIONS_DIR, EXTENSION_CONFIG, 
  NAMASTE_PREFIX_STORAGE, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = require('./constants').OcflConstants;
const DIGEST = require('./digest').OcflDigest.CONTENT;


const DEFAULT_LAYOUT = HashedNTupleStorageLayout;

/** 
 * @typedef {import('./extension').OcflExtensionConfig} OcflExtensionConfig
 * @typedef {import('./store').OcflStore} OcflStore
 */

class OcflStorage {
  static LAYOUT;

  /**
   * Get the storage root
   * @return {string}
   */
  get root() { throw new NotImplementedError(); }

  /**
   * Construct the path of the object root relative to the storage root
   * The path is mapped from the object identifier using the algorithm defined in the chosen 
   * storage layout extension (specified in {@link OcflStorageConfig}).
   * @param {string} id - Identifier of the object
   * @return {string}
   */
  objectRoot(id) { throw new NotImplementedError(); }

  /**
   * Absolute path to the object root
   * @param {string} id - Identifier of the object 
   */
  objectRootAbs(id) {
    return path.join(this.root, this.objectRoot(id));
  }

  /**
   * Get an existing object in the Storage or create a new one.
   * @param {string|{id?:string, root?:string}} opt - A unique identifier for the OCFL Object, should be a URI
   * @return {OcflObject}
   */
  object(opt) { throw new NotImplementedError(); }

  /**
   * Check if the storage has already the object with the given id.
   * @param {*} id 
   */
  async has(id) {
    return this.object(id).exists();
  }

  /**
   * Create the storage root in the underlying storage backend
   * @param {Object} [options] - Additional options for creating storage root
   * @param {boolean} [options.ocflSpecText=false] - If true, create a copy of the OCFL specification text in the storage root
   */
  async create(options) { throw new NotImplementedError(); }

  /**
   * Check if the storage root path points to an existing file or non-empty directory in the underlying backend store.
   * The existing directory may or may not be a valid OCFL Storage.
   * @return {Promise<boolean>}
   */
  async exists() { throw new NotImplementedError(); }

  /**
   * Check namaste, retrieve storage layout extension, and read its config file.
   * @return {Promise<boolean>}
   */
  async load() { throw new NotImplementedError(); }

  /**
   * 
   * @return {AsyncIterator<OcflObject>}
   */
  [Symbol.asyncIterator]() { throw new NotImplementedError(); }

  /**
   * Return all OCFL objects under this storage as array
   * @return {Promise<OcflObject[]>}
   */
  async objects() {
    const objects = []; 
    for await(const o of this) objects.push(o); 
    return objects;
  }

  async delete(id) {
    return this.remove(id);
  }
  async purge(id) {
    return this.remove(id);
  }

  async remove(id) { throw new NotImplementedError(); }

};

/**
 * @typedef {Object} OcflStorageConfig
 * @property {string} root - Absolute path to the ocfl storage root
 * @property {string} [workspace] - Absolute path to storage workspace directory
 * @property {OcflStorageLayout|OcflExtensionConfig|string} [layout] - A layout that identifies an arrangement of directories and OCFL objects under the storage root
 * @property {('sha256' | 'sha512')} [digestAlgorithm] - Digest algorithm for content-addressing, must use either sha512 or sha256
 * @property {string} [contentDirectory='content'] - Content directory name. Only applies to a newly created object.
 * @property {string} [ocflVersion=c.OCFL_VERSION] - Ocfl version. Only applies to a newly created object.
 */

/**
 * General implementation of {@link OcflStorage} that can uses different datastore backends. 
 * This class provides common functionalities for the subclasses and 
 * at the same provide encapsulation emulating private and protected methods.
 * @implements {OcflStorage}
 */
class OcflStorageImpl extends OcflStorage {

  /** @type {string} */
  #root;
  /** @type {string} */
  #workspace;
  /** @type {OcflStorageLayout} */
  #layout;
  /** @type {OcflStore} */
  #store;
  #objectConfig;

  /**
   * 
   * @param {OcflStorageConfig} config 
   * @param {OcflStore} store
   */
  constructor(config, store) {
    super();
    if (!store) throw new TypeError('[OcflStorage] store is required.');
    if (!config.root) throw new TypeError('[OcflStorage] config.root is required.');
    this.#store = store;
    const { root, workspace, layout, ocflVersion, ...objectConfig } = config;
    this.#root = path.resolve(root);
    this.#workspace = workspace ? path.resolve(workspace) : undefined;
    if (this.#workspace && this.#workspace.startsWith(this.#root + path.sep)) {
      throw new Error('[OcflStorage] config.workspace cannot be the same as or a subpath of config.root');
    }
    this.#layout = layout instanceof OcflStorageLayout ? layout : this.#createLayout(layout);
    this.ocflVersion = ocflVersion || OCFL_VERSION;
    this.#objectConfig = objectConfig;
  }

  /**
   * 
   * @param {OcflExtensionConfig|string} option 
   */
  #createLayout(option) {
    let name = typeof option === 'string' ? option : option?.extensionName;
    let config = typeof option === 'object' ? option : null;
    if (name) {
      return OcflStorageLayout.class(name).create(config);
    }
    // else if (useDefault) {
    //   return DEFAULT_LAYOUT.create(config);
    // }
  }

  get root() { return this.#root; }

  objectRoot(id) {
    if (!this.#layout) throw new Error('[OcflStorage] No layout defined');
    return this.#layout.map(id);
  }

  /**
   * The root param is a relative path to the storage root.
   * @param {string|{id?:string, root?:string}} opt 
   */
  object(opt) {
    let id, root;
    if (typeof opt === 'string') id = opt;
    else ({id, root} = opt);
    let relObjectRoot = root || this.objectRoot(id);
    return new OcflObjectImpl({
      id,
      root: path.join(this.root, relObjectRoot),
      // @todo:use extension workspace if not defined
      workspace: this.#workspace ? path.join(this.#workspace, relObjectRoot) : undefined,
      ocflVersion: this.ocflVersion,
      ...this.#objectConfig
    },
      this.#store);
  }

  async exists() {
    return !(await isDirEmpty(this.#store, this.root));
  }

  async load() {
    let prefix = NAMASTE_PREFIX_STORAGE;
    let tasks = [
      findNamasteVersion(this.#store, prefix, this.root),
      this.#store.readFile(path.join(this.root, OCFL_LAYOUT), 'utf8')
    ];
    // @ts-ignore
    let [ocflVersion, layout] = (await Promise.allSettled(tasks)).map(r => r.value);
    if (!ocflVersion) return false;//throw validation.createError(67, this.root);
    let layoutName, layoutConfig;
    // load layout
    try {
      if (layout) layoutName = JSON.parse(layout).extension;
    } catch (error) {
    }
    // load ext config if exists
    try {
      let cfgstr = await this.#store.readFile(path.join(this.root, EXTENSIONS_DIR, layout, EXTENSION_CONFIG), 'utf8');
      layoutConfig = JSON.parse(/**@type{string}*/(cfgstr));
    } catch (error) {
    }
    this.#layout = this.#createLayout(layoutConfig || layoutName);

    //@todo: load storage level extensions

    return true;
  }

  /**
   * @param {Object} [options] - Additional options for creating storage root
   * @param {boolean} [options.ocflSpecText=false] - If true, create a copy of the OCFL specification text in the storage root
   */
  async create(options) {
    if (await this.exists()) {
      //cannot create, storage root already exists .
      throw new Error('[OcflStorage] Cannot create storage root in a non-empty directory');
    } else {
      await this.#store.mkdir(this.root);
    }
    // create namaste
    let prefix = NAMASTE_PREFIX_STORAGE;
    let filenamePrefix = NAMASTE_T + prefix;
    let filePath = path.join(this.root, filenamePrefix + this.ocflVersion);
    await this.#store.writeFile(filePath, prefix + this.ocflVersion + '\n', 'utf8');

    // create layout
    if (!this.#layout) {
      this.#layout = DEFAULT_LAYOUT.create();
    }
    let layout = { extension: this.#layout.name, description: this.#layout.description };
    await this.#store.writeFile(path.join(this.root, OCFL_LAYOUT), JSON.stringify(layout, null, 2), 'utf8');
    if (this.#layout.config) {
      await this.#store.writeFile(path.join(this.root, EXTENSIONS_DIR, EXTENSION_CONFIG), JSON.stringify(this.#layout.config, null, 2), 'utf8');
    }

    // todo: create other extensions
    if (options?.ocflSpecText) {

    }
  }

  /**
   * @return {AsyncIterator<OcflObject, OcflObject>}
   */
  [Symbol.asyncIterator]() {
    let store = this.#store;
    let workspace = this.#workspace;
    let config = this.#objectConfig;
    let root = this.root;
    let stack = [this.#store.opendir(this.root)];
    return {
      async next() {
        let dirp;
        while ((dirp = stack.pop())) {
          let dir = await dirp;
          let dirent = await dir.read();
          if (!dirent) {
            await dir.close();
            continue;
          }
          stack.push(dirp);
          if (!dirent.isDirectory()) continue;
          let basePath = path.join(dir.path, dirent.name);
          let nv;
          try {
            nv = await findNamasteVersion(store, NAMASTE_PREFIX_OBJECT, basePath);
          } catch (err) {
          }
          if (nv) {
            //ocfl object exists
            // inventory exists
            let object = new OcflObjectImpl({
              root: basePath,
              workspace: workspace ? path.join(workspace, path.relative(root, basePath)) : undefined,
              ocflVersion: nv,
              ...config
            }, store);
            //await object.load();
            return { done: false, value: object };
          } else {
            //ocfl object does not exist, process subdir 
            stack.push(store.opendir(basePath));
          }

        }
        return { done: true, value: null };
      }
      // return() {
      //   return { done: true };
      // }
    };
  }

}

module.exports = {
  OcflStorage,
  OcflStorageImpl
};