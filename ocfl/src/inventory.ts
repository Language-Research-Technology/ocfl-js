import type { Inventory, InventoryDigests, InventoryVersion } from './types.ts';

/** Digest values keyed by algorithm name */
type Digests = { [algorithm: string]: string };

export interface InventoryFile {
  logicalPath: string;
  version: string;
  digest: string;
  contentPath: string;
  fixity: Digests;
  size?: number;
  lastModified?: number;
}

class VersionNumber {
  value: number;
  zeroPaddingLength: number | undefined;
  constructor(num: number, zeroPaddingLength?: number) {
    this.value = num;
    this.zeroPaddingLength = zeroPaddingLength;
  }
  valueOf() {
    return this.value;
  }
  toString() {
    return `v${this.zeroPaddingLength ? `${this.value}`.padStart(this.zeroPaddingLength, '0') : this.value}`;
  }
  next() {
    return new VersionNumber(this.value + 1, this.zeroPaddingLength);
  }
  previous() {
    const n = this.value - 1;
    if (n > 0) {
      return new VersionNumber(n, this.zeroPaddingLength);
    }
  }
  static fromInt(num: number, zeroPaddingLength: number) {
    return new VersionNumber(num, zeroPaddingLength);
  }
  static fromString(versionLabel: string) {
    const label = versionLabel.replace('v', '');
    let zeroPaddingLength: number | undefined;
    if (label.startsWith('0')) {
      zeroPaddingLength = label.length;
    }
    return new VersionNumber(parseInt(label, 10), zeroPaddingLength);
  }

  static next(versionLabel: string) {
    return VersionNumber.fromString(versionLabel).next();
  }

  static previous(versionLabel: string) {
    return VersionNumber.fromString(versionLabel).previous();
  }
}

function findKey(file: string, obj: InventoryDigests): string | undefined {
  for (const digest in obj) {
    if (obj[digest]?.includes(file)) {
      return digest;
    }
  }
}

function headNotInVersionsError(head: string) {
  return new Error(`Inventory head "${head}" is not in versions.`);
}

/**
 * Wrapper class for inventory data
 */
class OcflObjectInventory {
  #data: Inventory;
  #fileIndex: { [version: string]: { [logicalPath: string]: Digests } } = {};

  metadata: { [contentPath: string]: { size: number; lastModified: number } } | undefined;

  /**
   * Helper function to find the digest by logical file path and cached it by indexing
   */
  _indexGet(logicalPath: string, version: string, onlyUsecache?: boolean): Digests | undefined {
    let digests = this.#fileIndex[version]?.[logicalPath];
    if (!digests && !onlyUsecache) {
      // search and then index
      const fixity = this.fixity;
      const algo = this.digestAlgorithm;
      const digestArr: [string, string][] = [];
      const mainDigest = findKey(logicalPath, this.versionState(version) ?? {});
      if (mainDigest) {
        digestArr.push([algo, mainDigest]);
        const cp = this.getContentPath(mainDigest);
        if (fixity && cp) {
          for (const [fixityDigest, digestBlock] of Object.entries(fixity)) {
            const digest = findKey(cp, digestBlock);
            if (digest) {
              digestArr.push([fixityDigest, digest]);
            }
          }
        }
      }
      if (digestArr.length > 0) {
        this.#fileIndex[version] ??= {};
        digests = Object.fromEntries(digestArr);
        this.#fileIndex[version][logicalPath] = digests;
      }
    }
    return digests;
  }

  _indexAdd(logicalPath: string, version: string, digests: Digests) {
    this.#fileIndex[version] ??= {};
    this.#fileIndex[version][logicalPath] = digests;
  }

  _indexRemove(logicalPath: string, version = this.head) {
    const index = this.#fileIndex[version];
    const val = index?.[logicalPath];
    delete index?.[logicalPath];
    return val;
  }

  _indexBuild() {
    // index fixity contentPaths
    const fixity = this.fixity;
    const fixityIndex: { [algorithm: string]: { [contentPath: string]: string } } = {};
    if (fixity) {
      for (const [fixityAlgo, digestBlock] of Object.entries(fixity)) {
        const fixityIndexDigest: { [contentPath: string]: string } = {};
        fixityIndex[fixityAlgo] = fixityIndexDigest;
        for (const [digest, cps] of Object.entries(digestBlock)) {
          for (const cp of cps) {
            fixityIndexDigest[cp] = digest;
          }
        }
      }
    }
    // index logicalPaths
    // { v1: { 'dir/file.txt': { sha512: 'abcdef' } } }
    const index: { [version: string]: { [logicalPath: string]: Digests } } = {};
    this.#fileIndex = index;
    const algo = this.digestAlgorithm;
    const fixityEntries = Object.entries(fixityIndex);
    for (const [verName, ver] of Object.entries(this.versions)) {
      const indexVer: { [logicalPath: string]: Digests } = {};
      index[verName] = indexVer;
      for (const [digest, lps] of Object.entries(ver.state)) {
        this.#requireContentPath(digest);
        const cps = this.manifest[digest] || [];
        for (const lp of lps) {
          const file: Digests = { [algo]: digest };
          indexVer[lp] = file;
          for (const [fixityAlgo, fixityIndexDigest] of fixityEntries) {
            for (const cp of cps) {
              const fixityDigest = fixityIndexDigest[cp];
              if (fixityDigest) {
                file[fixityAlgo] = fixityDigest;
              }
            }
          }
        }
      }
    }
  }

  _indexFindPaths(prefix: string, version = this.head) {
    const res: string[] = [];
    const index = this.#fileIndex[version];
    const prefixWithSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    for (const lp in index) {
      if (index[lp] && (lp === prefix || lp.startsWith(prefixWithSlash))) {
        res.push(lp);
      }
    }
    return res;
  }

  /**
   * Create a new mutable OcflObjectInventory from the object config or clone an existing inventory,
   * and increase the inventory version number. If data.head is undefined, starts from v1.
   */
  static newVersion(data: Partial<Inventory> | OcflObjectInventory, cleanState?: boolean) {
    if (data instanceof OcflObjectInventory) {
      data = data.toJSON();
    }
    if (!data.id || !data.digestAlgorithm || !data.type) {
      throw new Error('Inventory must have an id, digestAlgorithm and type.');
    }
    data.manifest = data.manifest || {};
    data.versions = data.versions || {};
    let prevVer: InventoryVersion | undefined;
    const prevHead = data.head;
    if (prevHead) {
      prevVer = data.versions[prevHead];
      data.head = VersionNumber.next(prevHead).toString();
    } else {
      data.head = 'v1';
      cleanState = true;
    }
    let state: InventoryDigests = {};
    if (!cleanState) {
      if (!prevVer) {
        throw headNotInVersionsError(prevHead ?? '');
      }
      state = JSON.parse(JSON.stringify(prevVer.state));
    }
    data.versions[data.head] = {
      created: new Date().toISOString(),
      state,
    };
    return new OcflObjectInventoryMut(data as Inventory);
  }

  /**
   * Create a new inventory model
   * @param data - Initial data of the inventory
   * @param version - Set the version, default to data.head
   */
  constructor(data: Inventory, _version?: string) {
    this.#data = data;
    this._indexBuild();
  }

  get id() {
    return this.#data.id;
  }
  get type() {
    return this.#data.type;
  }
  get digestAlgorithm() {
    return this.#data.digestAlgorithm;
  }
  get head() {
    return this.#data.head;
  }
  /** The version number of the current head */
  get versionNumber() {
    return VersionNumber.fromString(this.head);
  }
  get contentDirectory() {
    return this.#data.contentDirectory || 'content';
  }
  get manifest() {
    return this.#data.manifest;
  }
  get versions() {
    return this.#data.versions;
  }
  /** The current head version. Throws if the head is not in versions. */
  get version() {
    const version = this.versions[this.head];
    if (!version) {
      throw headNotInVersionsError(this.head);
    }
    return version;
  }
  get fixity(): Inventory['fixity'] {
    return this.#data.fixity;
  }
  set fixity(val: NonNullable<Inventory['fixity']>) {
    this.#data.fixity = val;
  }
  /** The state of the current version */
  get state() {
    return this.version.state;
  }
  get created() {
    return this.version.created;
  }
  get message(): InventoryVersion['message'] {
    return this.version.message;
  }
  get user(): InventoryVersion['user'] {
    return this.version.user;
  }
  //get nextVersion() { return this.versionNumber.next().toString(); }
  //get prevVersion() { return this.versionNumber.previous()?.toString(); }

  /** Return true if there has been actual change to the state of current version compared to the previous version */
  get isChanged() {
    const prev = this.versionNumber.previous()?.toString();
    if (!prev) {
      return true;
    }
    const diff = this.diffState(this.head, prev);
    return Object.keys(diff[0]).length > 0 || Object.keys(diff[1]).length > 0;
  }
  set created(val) {
    this.version.created = val;
  }
  set message(val: NonNullable<InventoryVersion['message']>) {
    this.version.message = val;
  }
  set user(val: NonNullable<InventoryVersion['user']>) {
    this.version.user = val;
  }

  /**
   * Return the state of the specified version
   * @param version - The inventory version, default to the latest
   */
  versionState(version?: string) {
    if (!version || version === 'latest') {
      version = this.head;
    }
    return this.versions[version]?.state;
  }

  toString() {
    return JSON.stringify(this.#data, null, 2);
  }

  toJSON(): Inventory {
    return JSON.parse(this.toString());
  }

  /**
   * @param version - The version name
   */
  *files(version?: string): Generator<InventoryFile> {
    let state: InventoryDigests | undefined;
    if (!version || version === 'latest') {
      state = this.state;
      version = this.head;
    } else {
      state = this.versions[version]?.state;
    }
    for (const [digest, files] of Object.entries(state ?? {})) {
      const contentPath = this.#requireContentPath(digest);
      for (const logicalPath of files) {
        yield {
          logicalPath,
          version,
          digest,
          contentPath,
          fixity: this.getFixity(logicalPath, version),
          ...this.metadata?.[contentPath],
        };
      }
    }
  }

  *find(fn: (file: InventoryFile) => boolean, version?: string) {
    for (const f of this.files(version)) {
      if (fn(f)) {
        yield f;
      }
    }
  }

  clone() {
    return new OcflObjectInventory(this.toJSON());
  }

  /**
   * Get the first content path found with the given digest from the manifest.
   * Also can be used to check the existance of an entry with the specified digest in the manifest.
   * @returns The first content path found in the array
   */
  getContentPath(digest: string): string | undefined {
    const cp = this.manifest[digest];
    if (cp && cp.length > 0) {
      return cp[0];
    }
  }

  #requireContentPath(digest: string): string {
    const cp = this.getContentPath(digest);
    if (!cp) {
      throw new Error(`Digest "${digest}" is not in the manifest of object "${this.id}".`);
    }
    return cp;
  }

  /**
   * Get the digest of a content represented by the logicalPath of the specified version
   */
  getDigest(logicalPath: string, versionName: string = this.head) {
    return this._indexGet(logicalPath, versionName, true)?.[this.digestAlgorithm];
  }

  /**
   * Get the file information by the logicalPath of the specified version
   */
  getFile(logicalPath: string, versionName: string = this.head): InventoryFile | undefined {
    const digest = this.getDigest(logicalPath, versionName);
    const version = versionName;
    if (digest) {
      const contentPath = this.#requireContentPath(digest);
      return {
        logicalPath,
        version,
        digest,
        contentPath,
        fixity: this.getFixity(logicalPath, version),
        ...this.metadata?.[contentPath],
      };
    }
  }

  getFileByDigest(digest: string, versionName?: string): InventoryFile | undefined {
    if (versionName) {
      const logicalPath = this.versions[versionName]?.state[digest]?.[0];
      return logicalPath ? this.getFile(logicalPath, versionName) : undefined;
    }
    for (const [version, { state }] of Object.entries(this.versions)) {
      const logicalPath = state[digest]?.[0];
      if (logicalPath) {
        return this.getFile(logicalPath, version);
      }
    }
  }

  getFileByContentPath(contentPath: string, versionName?: string): InventoryFile | undefined {
    for (const digest in this.manifest) {
      if (this.manifest[digest]?.includes(contentPath)) {
        return this.getFileByDigest(digest, versionName);
      }
    }
  }

  /**
   * Get the fixity of a content represented by the logicalPath of the specified version
   */
  getFixity(logicalPath: string, versionName: string = this.head): Digests {
    const { [this.digestAlgorithm]: digest, ...fixity } = this._indexGet(logicalPath, versionName, true) || {};
    return fixity;
  }

  /**
   * Compare the differences between the state of two versions
   * @returns A tuple of [A, B] where A contains files
   *     that are in `version0` but not in `version1` and B contains files
   *     that are in `version1` but not in `version0`
   */
  diffState(version0: string, version1: string): [InventoryDigests, InventoryDigests] {
    const state1 = this.versionState(version0) ?? {};
    const state2 = this.versionState(version1) ?? {};
    const diff = (s1: InventoryDigests, s2: InventoryDigests) => {
      const r: InventoryDigests = {};
      for (const [d, d1] of Object.entries(s1)) {
        const d2 = s2[d];
        const files = d2?.length ? d1.filter((f) => !d2.includes(f)) : d1.slice();
        if (files.length > 0) {
          r[d] = files;
        }
      }
      return r;
    };
    return [diff(state1, state2), diff(state2, state1)];
  }
}

/**
 * Wrapper class with mutable methods for inventory data
 */
class OcflObjectInventoryMut extends OcflObjectInventory {
  /** The digest of a logical path and the state entry listing it */
  #stateEntry(logicalPath: string, version: string = this.head): { digest: string; files: string[] } | undefined {
    const digest = this.getDigest(logicalPath, version);
    const files = digest ? this.versionState(version)?.[digest] : undefined;
    return digest && files ? { digest, files } : undefined;
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @returns true if the state is changed
   */
  add(logicalPath: string, digest: string, fixity?: { [x: string]: string }): boolean {
    const state = this.state;
    const contentPath = `${this.head}/${this.contentDirectory}/${logicalPath}`;
    // add fixity info
    if (fixity) {
      for (const [digestName, digestValue] of Object.entries(fixity)) {
        this.addFixity(contentPath, digestName, digestValue);
      }
    }
    const files = state[digest];
    if (files) {
      // this is a file with identical content but different name
      if (files.indexOf(logicalPath) < 0) {
        files.push(logicalPath);
      } else {
        return false; // else, same digest and path, ignore
      }
    } else {
      const mf = this.manifest[digest];
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
   */
  addFixity(contentPath: string, digestName: string, digestValue: string) {
    if (!digestValue || !digestName) {
      return;
    }
    this.fixity ??= {};
    this.fixity[digestName] ??= {};
    const digestBlock = this.fixity[digestName];
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
   */
  rename(srcLogicalPath: string, destLogicalPath: string) {
    const srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : `${srcLogicalPath}/`;
    const destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : `${destLogicalPath}/`;
    const srcList = this._indexFindPaths(srcPrefix);
    const pairs = srcList.map((src): [string, string] => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) {
      pairs.push([srcLogicalPath, destLogicalPath]);
    }
    for (const [src, dest] of pairs) {
      const entry = this.#stateEntry(src);
      const index = entry?.files.indexOf(src) ?? -1;
      if (entry && index >= 0) {
        this.delete(dest); //overwrite
        entry.files[index] = dest;
        const digests = this._indexRemove(src, this.head);
        if (digests) {
          this._indexAdd(dest, this.head, digests);
        }
      } else {
        /** @todo decide: throw error or silently ignore non-existant file? */
      }
    }
  }

  /**
   * Create an alias or reference of a logical path
   */
  copy(srcLogicalPath: string, destLogicalPath: string) {
    const srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : `${srcLogicalPath}/`;
    const destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : `${destLogicalPath}/`;
    const srcList = this._indexFindPaths(srcPrefix);
    const pairs = srcList.map((src): [string, string] => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) {
      pairs.push([srcLogicalPath, destLogicalPath]);
    }
    for (const [src, dest] of pairs) {
      if (!dest) {
        throw new Error(`Target logical path cannot be empty`);
      }
      const digests = this._indexGet(src, this.head, true);
      const entry = this.#stateEntry(src);
      if (!digests || !entry) {
        throw new Error(`Source logical path "${src}" does not exist in object [${this.id}]`);
      }
      if (entry.files.indexOf(dest) >= 0) {
        /** @todo decide: throw error or silently ignore existing dest file? */
      } else {
        entry.files.push(dest);
        this._indexAdd(dest, this.head, digests);
      }
    }
  }

  /**
   * Delete a file
   */
  delete(logicalPath: string, version: string = this.head) {
    const names = this._indexFindPaths(logicalPath, version);
    let count = 0;
    const state = this.versionState(version);
    if (!state) {
      return 0;
    }
    for (const lp of names) {
      const entry = this.#stateEntry(lp, version);
      if (!entry) {
        continue;
      }
      const { digest, files } = entry;
      const index = files.indexOf(lp);
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

  reinstate(logicalPath: string, versionName: string) {
    const names = this._indexFindPaths(logicalPath, versionName);
    //let digest = this.getDigest(logicalPath, versionName);
    const state = this.state;
    let count = 0;
    for (const lp of names) {
      const digests = this._indexGet(lp, versionName);
      const digest = digests?.[this.digestAlgorithm];
      if (digests && digest) {
        this.delete(lp);
        state[digest] = [lp];
        this._indexAdd(lp, this.head, digests);
        count++;
      }
    }
    return count;
  }
}

export { headNotInVersionsError, OcflObjectInventory, OcflObjectInventoryMut, VersionNumber };
