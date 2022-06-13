//@ts-check

const path = require('path');
const { digestSync } = require('./digest.js').OcflDigest;
//const {createHash} = require('crypto');

function nextVersion(currentVersion) {
  let zeroPaddingLength = 0;
  let currentVer = currentVersion.replace('v', '');
  if (currentVer.startsWith('0')) zeroPaddingLength = currentVer.length;
  let newVer = '' + (parseInt(currentVer) + 1);
  newVer = 'v' + (zeroPaddingLength ? newVer.padStart(zeroPaddingLength, '0') : newVer);
  return newVer;
}

function prevVersion(currentVersion) {
  let zeroPaddingLength = 0;
  let currentVer = currentVersion.replace('v', '');
  if (currentVer.startsWith('0')) zeroPaddingLength = currentVer.length;
  let prevVer = '' + (parseInt(currentVer) - 1);
  prevVer = 'v' + (zeroPaddingLength ? prevVer.padStart(zeroPaddingLength, '0') : prevVer);
  return prevVer;
}

/**
 * @typedef {{logicalPath?: string; digest?: string; contentPath?: string;}} FileRef
 */

/**
 * @typedef {Object.<string, string[]>} InventoryState
 */

/**
 * @typedef {Object} InventoryVersion
 * @property {string} [created]
 * @property {InventoryState} state
 * @property {string} [message]
 * @property {{name:string, address:string}} [user]
 */

/**
 * @typedef {Object} Inventory
 * @property {string} id - A unique identifier for the OCFL Object.
 * @property {string} type - The URI of the inventory section of the specification version matching the object conformance declaration.
 * @property {string} digestAlgorithm - The digest algorithm used for calculating digests for content-addressing within the OCFL Object and for the Inventory Digest.
 * @property {string} head - The version directory name of the most recent version of the object.
 * @property {string} [contentDirectory='content'] - The name of the designated content directory within the version directories.
 * @property {InventoryState} manifest
 * @property {Object.<string, InventoryVersion>} versions
 * @property {Object} [fixity]
 */


/**
 * Wrapper class for inventory data
 */
class OcflObjectInventory {
  /** @type {Inventory} */
  #data;
  /** @type {InventoryVersion} */
  #version;

  /**
   * Create a mutable inventory and increase the inventory version number
   * @param {Object} data
   * @param {string} data.id
   * @param {string} data.type
   * @param {string} data.digestAlgorithm
   * @param {string} [data.head]
   * @param {string} [data.contentDirectory]
   * @param {Object.<string, string[]>} [data.manifest]
   * @param {Object.<string, InventoryVersion>} [data.versions]
   * @param {Object} [data.fixity]
   * @param {boolean} [cleanState] 
   */
  static newVersion(data, cleanState) {
    if (!data.id || !data.digestAlgorithm || !data.type) throw new Error('Inventory must have an id, digestAlgorithm and type.');
    data.manifest = data.manifest || {};
    data.versions = data.versions || {};
    let prevVer;
    if (data.head) {
      prevVer = data.versions[data.head];
      data.head = nextVersion(data.head);
    } else {
      data.head = 'v1';
      cleanState = true;
    }
    data.versions[data.head] = {
      created: (new Date()).toISOString(),
      state: cleanState ? {} : JSON.parse(JSON.stringify(prevVer.state))
    };
    return new OcflObjectInventoryMut(data);
  }

  /**
   * Create a new inventory model
   * @param {Inventory} data - Initial data of the inventory
   * @param {string} [version] - Set the version, default to data.head
   */
  constructor(data, version) {
    this.#data = data;
    this.#version = data.versions[version || data.head];
  }

  get id() { return this.#data.id }
  get type() { return this.#data.type }
  get digestAlgorithm() { return this.#data.digestAlgorithm }
  get head() { return this.#data.head }
  get contentDirectory() { return this.#data.contentDirectory || 'content' }
  get manifest() { return this.#data.manifest }
  get versions() { return this.#data.versions }
  get fixity() { return this.#data.fixity }
  get state() { return this.#version.state }
  get created() { return this.#version.created }
  get message() { return this.#version.message }
  get user() { return this.#version.user }
  get prevVersion() { return prevVersion(this.head); }

  /** Return true if there has been actual change to the state of current version compared to the previous version */
  get isChanged() {
    let diff = this.diffState(this.head, prevVersion(this.head));
    return Object.keys(diff[0]).length > 0 || Object.keys(diff[1]).length > 0;
  }
  set created(val) { this.#version.created = val; }
  set message(val) { this.#version.message = val; }
  set user(val) { this.#version.user = val; }

  /**
   * Return the state of the specified version
   * @param {string} [version ] - The inventory version, default to the latest
   */
  versionState(version) {
    if (!version || version === 'latest') version = this.head;
    return this.versions[version]?.state;
  }

  toString() {
    return JSON.stringify(this.#data, null, 2);
  }

  /** Compute digest from current state of this inventory object*/
  digest() {
    return digestSync(this.#data.digestAlgorithm, this.toString());
  }

  /**
   * @return {Inventory}
   */
  toJSON() {
    return JSON.parse(this.toString());
  }

  /**
   * 
   * @param {string} [version] - The version name 
   */
  *files(version) {
    let state = (!version || version === 'latest') ? this.state : this.versions[version]?.state;
    for (let digest in state) {
      let files = state[digest];
      let contentPath = this.getContentPath(digest);
      for (let logicalPath of files) {
        yield {
          logicalPath,
          digest,
          contentPath
        };
      }
    }
  }

  *find(fn, version) {
    for (let f of this.files(version)) {
      if (fn(f)) yield f;
    }
  }

  clone() {
    return new OcflObjectInventory(this.toJSON());
  }

  /**
   * Get the first content path found with the given digest from the manifest. 
   * Also can be used to check the existance of an entry with the specified digest in the manifest.
   * @param {string} digest 
   * @return {string} - The first content path found in the array
   */
  getContentPath(digest) {
    let cp = this.manifest[digest];
    if (cp && cp.length > 0) return cp[0];
  }

  /**
   * Get the content digest of the specified logicalPath
   * @param {string} logicalPath 
   * @param {string} [versionName] 
   * @returns 
   */
  getDigest(logicalPath, versionName) {
    let state = this.versionState(versionName);
    return Object.keys(state).find(d => state[d].includes(logicalPath));
  }

  /**
   * Compare the differences between the state of two versions
   * @param {string} version0
   * @param {string} version1 
   * @return {[InventoryState, InventoryState]} - A tuple of [A, B] where A contains files
   *     that are in `version0` but not in `version1` and B contains files
   *     that are in `version1` but not in `version0`
   */
  diffState(version0, version1) {
    var state1 = this.versionState(version0) ?? {};
    var state2 = this.versionState(version1) ?? {};

    var result = [[state1, state2], [state2, state1]].map(([s1, s2]) => {
      /** @type {Map<string, string[]>} */
      let r = new Map();
      for (let d in s1) {
        let d1 = s1[d];
        let d2 = s2[d];
        let diff;
        if (d2 && d2.length) {
          diff = d1.filter(f => !d2.includes(f));
        } else {
          diff = d1.slice();
        }
        if (diff.length > 0) r.set(d, diff);
      }
      return Object.fromEntries(r);
    });

    return /** @type {[InventoryState, InventoryState]} */(result);
  }
}


/**
 * Wrapper class with mutable methods for inventory data
 */
class OcflObjectInventoryMut extends OcflObjectInventory {
  /** @type {Object.<string,string>} */
  #byPath;

  constructor(data) {
    super(data);
    //index logicalPaths
    let byPath = this.#byPath = {};
    let state = this.state;
    for (let d in state) {
      let files = state[d];
      for (let lp of files) {
        byPath[lp] = d;
      }
    }
  }

  /**
   * Get the digest of a content represented by the logicalPath of the specified version
   * @param {string} logicalPath 
   * @param {string} [versionName] 
   * @return {string}
   */
  getDigest(logicalPath, versionName) {
    if (versionName) return super.getDigest(logicalPath, versionName);
    else return this.#byPath[logicalPath];
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @param {string} digest
   * @param {string} logicalPath 
   * @return {boolean} - true if the state is changed
   */
  add(logicalPath, digest) {
    let state = this.state;
    if (state[digest]) {
      // this is a file with identical content but different name
      if (state[digest].indexOf(logicalPath) < 0) state[digest].push(logicalPath);
      else return false; // else, same digest and path, ignore
    } else {
      let mf = this.manifest[digest];
      if (mf && mf.length > 0) {
        // this is a reinstatement
      } else {
        if (this.#byPath[logicalPath]) {
          // this is an update, remove old digest
          this.delete(logicalPath);
        } else {
          // normal addition
        }
        this.manifest[digest] = [path.join(this.head, this.contentDirectory, logicalPath)];
      }
      state[digest] = [logicalPath];
    }
    this.#byPath[logicalPath] = digest;
    return true;
  }

  /**
   * Rename a logical path. This will overwrite dest if exists
   * @param {string} srcLogicalPath 
   * @param {string} destLogicalPath 
   */
  rename(srcLogicalPath, destLogicalPath) {
    let srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : srcLogicalPath + '/';
    let destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : destLogicalPath + '/';
    let srcList = Object.keys(this.#byPath).filter(p => p.startsWith(srcPrefix));
    let pairs = srcList.map(src => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) pairs.push([srcLogicalPath, destLogicalPath]);
    for (let [src, dest] of pairs) {
      let digest = this.#byPath[src];
      let files = this.state[digest];
      let index = files?.indexOf(src);
      if (index >= 0) {
        this.delete(dest); //overwrite
        files[index] = dest;
        this.#byPath[dest] = digest;
        this.#byPath[src] = null;
      } else {
        /** @todo decide: throw error or silently ignore non-existant file? */
      }
    }
  }

  /**
   * Create an alias or reference of a logical path
   * @param {string} srcLogicalPath 
   * @param {string} destLogicalPath 
   */
  copy(srcLogicalPath, destLogicalPath) {
    let srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : srcLogicalPath + '/';
    let destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : destLogicalPath + '/';
    let srcList = Object.keys(this.#byPath).filter(p => p.startsWith(srcPrefix));
    let pairs = srcList.map(src => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) pairs.push([srcLogicalPath, destLogicalPath]);
    for (let [src, dest] of pairs) {
      let digest = this.#byPath[src];
      let files = this.state[digest];
      let index = files?.indexOf(dest);
      if (index >= 0) {
        /** @todo decide: throw error or silently ignore existing dest file? */
      } else {
        files.push(dest);
        this.#byPath[dest] = digest;
      }
    }
  }

  delete(logicalPath) {
    let prefix = logicalPath.endsWith('/') ? logicalPath : logicalPath + '/';
    let names = this.getDigest(logicalPath) ? [logicalPath] :
      Object.keys(this.#byPath).filter(p => p.startsWith(prefix));
    let count = 0;
    for (let lp of names) {
      let digest = this.#byPath[lp];
      let files = this.state[digest];
      let index = files?.indexOf(lp);
      if (index >= 0) {
        files.splice(index, 1);
        if (files.length === 0) delete this.state[digest];
        this.#byPath[lp] = null;
        count++;
      }
    }
    return count;
  }

  reinstate(logicalPath, versionName) {
    let prefix = logicalPath.endsWith('/') ? logicalPath : logicalPath + '/';
    let digest = this.getDigest(logicalPath, versionName);
    /** @type {FileRef[]} */
    let files = digest ? [{ logicalPath, digest }] :
      [...this.find(f => f.logicalPath.startsWith(prefix), versionName)];
    let state = this.state;
    let count = 0;
    for (let f of files) {
      if (this.getDigest(f.logicalPath)) {
        let c = this.delete(f.logicalPath);
      }
      state[f.digest] = [f.logicalPath];
      this.#byPath[f.logicalPath] = f.digest;
      count++;
    }
    return count;
  }

}

module.exports = { OcflObjectInventory, OcflObjectInventoryMut };