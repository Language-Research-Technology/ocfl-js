'use strict';

const { log } = require("console");
const { threadId } = require("worker_threads");

//@ts-check

class VersionNumber {
  value;
  zeroPaddingLength;
  /**
   * 
   * @param {number} num
   * @param {number} [zeroPaddingLength]
   */
  constructor(num, zeroPaddingLength) {
    this.value = num;
    this.zeroPaddingLength = zeroPaddingLength;
  }
  valueOf() {
    return this.value;
  }
  toString() {
    return 'v' + (this.zeroPaddingLength ? (this.value + '').padStart(this.zeroPaddingLength, '0') : this.value);
  }
  next() {
    return new VersionNumber(this.value + 1, this.zeroPaddingLength);
  }
  previous() {
    const n = this.value - 1;
    if (n > 0) return new VersionNumber(n, this.zeroPaddingLength);
  }
  /**
   * 
   * @param {number} num 
   * @param {number} zeroPaddingLength 
   */
  static fromInt(num, zeroPaddingLength) {
    return new VersionNumber(num, zeroPaddingLength);
  }
  /**
   * 
   * @param {string} versionLabel 
   */
  static fromString(versionLabel) {
    const label = versionLabel.replace('v', '');
    let zeroPaddingLength;
    if (label.startsWith('0')) zeroPaddingLength = label.length;
    return new VersionNumber(parseInt(label), zeroPaddingLength);
  }

  static next(versionLabel) {
    return VersionNumber.fromString(versionLabel).next();
  }

  static previous(versionLabel) {
    return VersionNumber.fromString(versionLabel).previous();
  }
}

/**
 * @typedef {{logicalPath?: string; digest?: string; contentPath?: string;}} FileRef
 */

function findKey(file, obj) {
  for (let digest in obj) {
    const arr = obj[digest];
    if (arr.includes(file)) return digest;
  }
}

/**
 * Wrapper class for inventory data
 */
class OcflObjectInventory {
  /** @type {Inventory} */
  #data;
  /** @type {{[key: string]: {[key:string]: {[key:string]: string}}}} */
  #fileIndex = {};

  metadata;

  /**
   * Helper function to find the digest by logical file path and cached it by indexing
   * @param {string} logicalPath
   * @param {string} version
   * @param {boolean} [onlyUsecache]
   */
  _indexGet(logicalPath, version, onlyUsecache) {
    let digests = this.#fileIndex[version]?.[logicalPath];
    if (!digests && !onlyUsecache) {
      // search and then index
      const fixity = this.fixity;
      const algo = this.digestAlgorithm;
      const digestArr = [];
      const mainDigest = findKey(logicalPath, this.versionState(version));
      if (mainDigest) {
        digestArr.push([algo, mainDigest]);
        if (fixity) {
          const cp = this.getContentPath(mainDigest);
          for (const fixityDigest in fixity) {
            const digest = findKey(cp, fixity[fixityDigest]);
            if (digest) digestArr.push([fixityDigest, digest]);
          }
        }
      }
      if (digestArr.length > 0) {
        const verIndex = this.#fileIndex[version] = this.#fileIndex[version] || {};
        digests = verIndex[logicalPath] = Object.fromEntries(digestArr);
      }
    }
    return digests;
  }

  _indexAdd(logicalPath, version, digests) {
    this.#fileIndex[version][logicalPath] = digests;
  }

  _indexRemove(logicalPath, version = this.head) {
    const val = this.#fileIndex[version][logicalPath];
    delete this.#fileIndex[version][logicalPath];
    return val;
  }

  _indexBuild() {
    // index fixity contentPaths
    const fixity = this.fixity;
    const fixityIndex = {};
    if (fixity) {
      for (const fixityAlgo in fixity) {
        const digestBlock = fixity[fixityAlgo];
        const fixityIndexDigest = fixityIndex[fixityAlgo] = {};
        for (const digest in digestBlock) {
          const cps = digestBlock[digest];
          for (const cp of cps) {
            fixityIndexDigest[cp] = digest;
          }
        }
      }
    }
    // index logicalPaths
    // { v1: { 'dir/file.txt': { sha512: 'abcdef' } } }
    const index = this.#fileIndex = {};
    const algo = this.digestAlgorithm;
    for (const verName in this.versions) {
      const ver = this.versions[verName];
      const indexVer = index[verName] = {};
      for (const digest in ver.state) {
        for (const lp of ver.state[digest]) {
          const file = indexVer[lp] = { [algo]: digest };
          if (fixity) {
            for (const fixityAlgo in fixityIndex) {
              const fixityIndexDigest = fixityIndex[fixityAlgo];
              const cps = this.manifest[digest] || [];
              for (const cp of cps) {
                if (fixityIndexDigest[cp]) file[fixityAlgo] = fixityIndexDigest[cp];
              }
            }
          }
        }
      }
    }
  }

  _indexFindPaths(prefix, version = this.head) {
    const res = [];
    const index = this.#fileIndex[version];
    const prefixWithSlash = prefix.endsWith('/') ? prefix : prefix + '/';
    for (const lp in index) {
      if (index[lp] && (lp === prefix || lp.startsWith(prefixWithSlash))) res.push(lp);
    }
    return res;
  }


  /**
   * Create a new mutable OcflObjectInventory from the object config or clone an existing inventory,
   * and increase the inventory version number. If data.head is undefined, starts from v1.
   * @param {Partial<Inventory> | OcflObjectInventory} data
   * @param {boolean} [cleanState] 
   */
  static newVersion(data, cleanState) {
    if (data instanceof OcflObjectInventory) {
      data = data.toJSON();
    }
    if (!data.id || !data.digestAlgorithm || !data.type) throw new Error('Inventory must have an id, digestAlgorithm and type.');
    data.manifest = data.manifest || {};
    data.versions = data.versions || {};
    let prevVer;
    if (data.head) {
      prevVer = data.versions[data.head];
      data.head = VersionNumber.next(data.head).toString();
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
    this._indexBuild();
  }

  get id() { return this.#data.id }
  get type() { return this.#data.type }
  get digestAlgorithm() { return this.#data.digestAlgorithm }
  get head() { return this.#data.head }
  /** The version number of the current head */
  get versionNumber() { return VersionNumber.fromString(this.head); }
  get contentDirectory() { return this.#data.contentDirectory || 'content' }
  get manifest() { return this.#data.manifest }
  get versions() { return this.#data.versions }
  get version() { return this.versions[this.head] }
  get fixity() { return this.#data.fixity }
  set fixity(val) { this.#data.fixity = val; }
  /** The state of the current version */
  get state() { return this.version.state }
  get created() { return this.version.created }
  get message() { return this.version.message }
  get user() { return this.version.user }
  //get nextVersion() { return this.versionNumber.next().toString(); }
  //get prevVersion() { return this.versionNumber.previous()?.toString(); }

  /** Return true if there has been actual change to the state of current version compared to the previous version */
  get isChanged() {
    const prev = this.versionNumber.previous()?.toString();
    if (!prev) return true;
    let diff = this.diffState(this.head, prev);
    return Object.keys(diff[0]).length > 0 || Object.keys(diff[1]).length > 0;
  }
  set created(val) { this.version.created = val; }
  set message(val) { this.version.message = val; }
  set user(val) { this.version.user = val; }

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
    let state;
    if (!version || version === 'latest') {
      state = this.state;
      version = this.head;
    } else {
      state = this.versions[version]?.state;
    }
    for (let digest in state) {
      let files = state[digest];
      let contentPath = this.getContentPath(digest);
      for (let logicalPath of files) {
        yield {
          logicalPath,
          version,
          digest,
          contentPath,
          fixity: this.getFixity(logicalPath, version),
          ...this.metadata?.[contentPath]
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
   * Get the digest of a content represented by the logicalPath of the specified version
   * @param {string} logicalPath 
   * @param {string} [versionName] 
   */
  getDigest(logicalPath, versionName = this.head) {
    return this._indexGet(logicalPath, versionName, true)?.[this.digestAlgorithm];
  }

  /**
   * Get the file information by the logicalPath of the specified version
   * @param {string} logicalPath 
   * @param {string} [versionName] 
   */
  getFile(logicalPath, versionName = this.head) {
    const digest = this.getDigest(logicalPath, versionName);
    const contentPath = this.getContentPath(digest);
    const version = versionName;
    if (digest) {
      return {
        logicalPath,
        version,
        digest,
        contentPath,
        fixity: this.getFixity(logicalPath, version),
        ...this.metadata?.[contentPath]
      }
    }
  }

  getFileByDigest(digest, versionName) {
    if (versionName) return this.getFile(this.versions[versionName].state[digest]?.[0], versionName);
    for (const version in this.versions) {
      const logicalPath = this.versions[version].state[digest]?.[0];
      if (logicalPath) return this.getFile(logicalPath, version);
    }
  }

  getFileByContentPath(contentPath, versionName) {
    for (const digest in this.manifest) {
      if (this.manifest[digest].includes(contentPath)) return this.getFileByDigest(digest, versionName);
    }
  }

  /**
   * Get the fixity of a content represented by the logicalPath of the specified version
   * @param {string} logicalPath 
   * @param {string} [versionName] 
   */
  getFixity(logicalPath, versionName = this.head) {
    const { [this.digestAlgorithm]: digest, ...fixity } = this._indexGet(logicalPath, versionName, true) || {};
    return fixity;
  }

  /**
   * Compare the differences between the state of two versions
   * @param {string} version0
   * @param {string} version1 
   * @return {[InventoryDigests, InventoryDigests]} - A tuple of [A, B] where A contains files
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

    return /** @type {[InventoryDigests, InventoryDigests]} */(result);
  }
}


/**
 * Wrapper class with mutable methods for inventory data
 */
class OcflObjectInventoryMut extends OcflObjectInventory {

  constructor(data) {
    super(data);
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @param {string} digest
   * @param {string} logicalPath 
   * @param {{[x: string]: string}} [fixity]
   * @return {boolean} - true if the state is changed
   */
  add(logicalPath, digest, fixity) {
    const state = this.state;
    const contentPath = this.head + '/' + this.contentDirectory + '/' + logicalPath;
    // add fixity info
    if (fixity) {
      for (const digestName in fixity) {
        this.addFixity(contentPath, digestName, fixity[digestName]);
      }
    }
    if (state[digest]) {
      // this is a file with identical content but different name
      if (state[digest].indexOf(logicalPath) < 0) state[digest].push(logicalPath);
      else return false; // else, same digest and path, ignore
    } else {
      let mf = this.manifest[digest];
      if (mf && mf.length > 0) {
        // this is a reinstatement
      } else {
        // normal addition of a new file
        this.manifest[digest] = [contentPath];
      }
      if (this.getDigest(logicalPath)) {
        // this is an update, remove old digest
        this.delete(logicalPath);
      }
      state[digest] = [logicalPath];
    }
    this._indexAdd(logicalPath, this.head, { [this.digestAlgorithm]: digest, ...fixity });
    return true;
  }

  /**
   * Low-level method to add a set of digest entries associated to file into the fixity block
   * @param {string} contentPath 
   * @param {string} digestName
   * @param {string} digestValue
   */
  addFixity(contentPath, digestName, digestValue) {
    if (!digestValue || !digestName) return;
    const fixityBlock = this.fixity = this.fixity || {};
    const digestBlock = fixityBlock[digestName] = fixityBlock[digestName] || {};
    if (digestBlock[digestValue]) {
      if (!digestBlock[digestValue].includes(contentPath)) {
        digestBlock[digestValue].push(contentPath);
      }
    } else {
      digestBlock[digestValue] = [contentPath];
    }
  }

  /**
   * Rename a logical path. This will overwrite dest if exists
   * @param {string} srcLogicalPath 
   * @param {string} destLogicalPath 
   */
  rename(srcLogicalPath, destLogicalPath) {
    let srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : srcLogicalPath + '/';
    let destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : destLogicalPath + '/';
    let srcList = this._indexFindPaths(srcPrefix);
    let pairs = srcList.map(src => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) pairs.push([srcLogicalPath, destLogicalPath]);
    for (let [src, dest] of pairs) {
      let digest = this.getDigest(src);
      let files = this.state[digest];
      let index = files?.indexOf(src);
      if (index >= 0) {
        this.delete(dest); //overwrite
        files[index] = dest;
        this._indexAdd(dest, this.head, this._indexRemove(src, this.head));
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
    let srcList = this._indexFindPaths(srcPrefix);
    let pairs = srcList.map(src => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) pairs.push([srcLogicalPath, destLogicalPath]);
    for (let [src, dest] of pairs) {
      if (!dest) throw new Error(`Target logical path cannot be empty`);
      let digest = this._indexGet(src, this.head, true);
      if (!digest) throw new Error(`Source logical path "${src}" does not exist in object [${this.id}]`);
      //console.log(this.state);
      let files = this.state[digest[this.digestAlgorithm]];
      let index = files?.indexOf(dest);
      if (index >= 0) {
        /** @todo decide: throw error or silently ignore existing dest file? */
      } else {
        files.push(dest);
        this._indexAdd(dest, this.head, digest);
      }
    }
  }

  /**
   * Delete a file
   * @param {string} logicalPath 
   * @param {string} [version] 
   */
  delete(logicalPath, version = this.head) {
    const names = this._indexFindPaths(logicalPath, version);
    let count = 0;
    const state = this.versionState(version);
    for (let lp of names) {
      const digest = this.getDigest(lp, version);
      const files = state[digest];
      const index = files?.indexOf(lp);
      if (index >= 0) {
        if (files.length === 1) {
          delete state[digest];
        } else {
          files.splice(index, 1);
        }
        this._indexRemove(lp, version);
        count++;
      }
    }
    return count;
  }

  reinstate(logicalPath, versionName) {
    let names = this._indexFindPaths(logicalPath, versionName);
    //let digest = this.getDigest(logicalPath, versionName);
    let state = this.state;
    let count = 0;
    for (let lp of names) {
      const digests = this._indexGet(lp, versionName);
      if (digests) {
        let c = this.delete(lp);
      }
      state[digests[this.digestAlgorithm]] = [lp];
      this._indexAdd(lp, this.head, digests);
      count++;
    }
    return count;
  }

}

module.exports = { OcflObjectInventory, OcflObjectInventoryMut, VersionNumber };