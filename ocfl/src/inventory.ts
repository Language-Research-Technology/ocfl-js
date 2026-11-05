import type { Inventory, InventoryDigests, InventoryVersion } from './types.ts';
import { createError } from './validation.ts';

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
  valueOf(): number {
    return this.value;
  }
  toString() {
    return `v${this.zeroPaddingLength ? `${this.value}`.padStart(this.zeroPaddingLength, '0') : this.value}`;
  }
  next(): VersionNumber {
    return new VersionNumber(this.value + 1, this.zeroPaddingLength);
  }
  previous(): VersionNumber | undefined {
    const n = this.value - 1;
    if (n > 0) {
      return new VersionNumber(n, this.zeroPaddingLength);
    }
  }
  static fromInt(num: number, zeroPaddingLength: number): VersionNumber {
    return new VersionNumber(num, zeroPaddingLength);
  }
  static fromString(versionLabel: string): VersionNumber {
    const label = versionLabel.replace('v', '');
    let zeroPaddingLength: number | undefined;
    if (label.startsWith('0')) {
      zeroPaddingLength = label.length;
    }
    return new VersionNumber(parseInt(label, 10), zeroPaddingLength);
  }

  static next(versionLabel: string): VersionNumber {
    return VersionNumber.fromString(versionLabel).next();
  }

  static previous(versionLabel: string): VersionNumber | undefined {
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

function isNonEmpty<T>(arr: T[] | undefined): arr is [T, ...T[]] {
  return arr !== undefined && arr.length > 0;
}

function headNotInVersionsError(id: string, head: string) {
  return createError('E040', id, `head "${head}" is not in versions`);
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

  _indexAdd(logicalPath: string, version: string, digests: Digests): void {
    this.#fileIndex[version] ??= {};
    this.#fileIndex[version][logicalPath] = digests;
  }

  _indexRemove(logicalPath: string, version: string = this.head): Digests | undefined {
    const index = this.#fileIndex[version];
    const val = index?.[logicalPath];
    delete index?.[logicalPath];
    return val;
  }

  _indexBuild(): void {
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
        const cps = this.#requireContentPaths(digest);
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

  _indexFindPaths(prefix: string, version: string = this.head): string[] {
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
  static newVersion(data: Partial<Inventory> | OcflObjectInventory, cleanState?: boolean): OcflObjectInventoryMut {
    if (data instanceof OcflObjectInventory) {
      data = data.toJSON();
    }
    if (!data.id || !data.digestAlgorithm || !data.type) {
      throw new Error('Inventory must have an id, digestAlgorithm and type.');
    }
    data.manifest = data.manifest || {};
    data.versions = data.versions || {};
    let state: InventoryDigests = {};
    if (data.head) {
      if (!cleanState) {
        const prev = data.versions[data.head];
        if (!prev) {
          throw headNotInVersionsError(data.id, data.head);
        }
        state = JSON.parse(JSON.stringify(prev.state));
      }
      data.head = VersionNumber.next(data.head).toString();
    } else {
      data.head = 'v1';
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
    // an empty head is an inventory with no versions yet
    if (data.head !== '' && !data.versions?.[data.head]) {
      throw headNotInVersionsError(data.id, data.head);
    }
    this.#data = data;
    this._indexBuild();
  }

  get id(): string {
    return this.#data.id;
  }
  get type(): 'https://ocfl.io/1.0/spec/#inventory' | 'https://ocfl.io/1.1/spec/#inventory' {
    return this.#data.type;
  }
  get digestAlgorithm(): 'sha256' | 'sha512' {
    return this.#data.digestAlgorithm;
  }
  get head(): string {
    return this.#data.head;
  }
  /** The version number of the current head */
  get versionNumber(): VersionNumber {
    return VersionNumber.fromString(this.head);
  }
  get contentDirectory(): string {
    return this.#data.contentDirectory || 'content';
  }
  get manifest(): InventoryDigests {
    return this.#data.manifest;
  }
  get versions(): {
    [key: string]: InventoryVersion;
  } {
    return this.#data.versions;
  }
  /** The current head version. Throws if the head is not in versions. */
  get version(): InventoryVersion {
    const version = this.versions[this.head];
    if (!version) {
      throw headNotInVersionsError(this.id, this.head);
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
  get state(): InventoryDigests {
    return this.version.state;
  }
  get created(): string {
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
  get isChanged(): boolean {
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
  versionState(version?: string): InventoryDigests | undefined {
    if (!version || version === 'latest') {
      version = this.head;
    }
    return this.versions[version]?.state;
  }

  toString(): string {
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
      const [contentPath] = this.#requireContentPaths(digest);
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

  *find(fn: (file: InventoryFile) => boolean, version?: string): Generator<InventoryFile, void, unknown> {
    for (const f of this.files(version)) {
      if (fn(f)) {
        yield f;
      }
    }
  }

  clone(): OcflObjectInventory {
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

  #requireContentPaths(digest: string): [string, ...string[]] {
    const cps = this.manifest[digest];
    if (!isNonEmpty(cps)) {
      throw createError('E050', this.id, `digest "${digest}" is not in the manifest`);
    }
    return cps;
  }

  /**
   * Get the digest of a content represented by the logicalPath of the specified version
   */
  getDigest(logicalPath: string, versionName: string = this.head): string | undefined {
    return this._indexGet(logicalPath, versionName, true)?.[this.digestAlgorithm];
  }

  /**
   * Get the file information by the logicalPath of the specified version
   */
  getFile(logicalPath: string, versionName: string = this.head): InventoryFile | undefined {
    const digest = this.getDigest(logicalPath, versionName);
    const version = versionName;
    if (digest) {
      const [contentPath] = this.#requireContentPaths(digest);
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
   * Remove exactly one logical path from its digest's list in the version state
   * @returns the removed path's digests, or undefined if it wasn't listed
   */
  #unlist(logicalPath: string, version: string = this.head): Digests | undefined {
    const entry = this.#stateEntry(logicalPath, version);
    const index = entry?.files.indexOf(logicalPath) ?? -1;
    if (!entry || index < 0) {
      return undefined;
    }
    if (entry.files.length === 1) {
      delete this.versionState(version)?.[entry.digest];
    } else {
      entry.files.splice(index, 1);
    }
    return this._indexRemove(logicalPath, version);
  }

  /** Append a logical path to its digest's list in the head version state */
  #list(logicalPath: string, digest: string, digests: Digests) {
    const state = this.state;
    state[digest] ??= [];
    state[digest].push(logicalPath);
    this._indexAdd(logicalPath, this.head, digests);
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @returns true if the state is changed
   */
  add(logicalPath: string, digest: string, fixity?: { [x: string]: string }): boolean {
    const contentPath = `${this.head}/${this.contentDirectory}/${logicalPath}`;
    // add fixity info
    if (fixity) {
      for (const [digestName, digestValue] of Object.entries(fixity)) {
        this.addFixity(contentPath, digestName, digestValue);
      }
    }
    if (this.getDigest(logicalPath) === digest) {
      return false;
    }
    // reinstated or duplicate content is already in the manifest
    if (!this.manifest[digest]?.length) {
      this.manifest[digest] = [contentPath];
    }
    this.#unlist(logicalPath);
    this.#list(logicalPath, digest, { [this.digestAlgorithm]: digest, ...fixity });
    return true;
  }

  /**
   * Low-level method to add a set of digest entries associated to file into the fixity block
   */
  addFixity(contentPath: string, digestName: string, digestValue: string): void {
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
  rename(srcLogicalPath: string, destLogicalPath: string): void {
    const srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : `${srcLogicalPath}/`;
    const destPrefix = destLogicalPath.endsWith('/') ? destLogicalPath : `${destLogicalPath}/`;
    const srcList = this._indexFindPaths(srcPrefix);
    const pairs = srcList.map((src): [string, string] => [src, destPrefix + src.slice(srcPrefix.length)]);
    if (pairs.length === 0) {
      pairs.push([srcLogicalPath, destLogicalPath]);
    }
    for (const [src, dest] of pairs) {
      const digests = this.#unlist(src);
      const digest = digests?.[this.digestAlgorithm];
      if (!digests || !digest) {
        /** @todo decide: throw error or silently ignore non-existant file? */
        continue;
      }
      this.delete(dest); // overwrite, including any paths under dest
      this.#list(dest, digest, digests);
    }
  }

  /**
   * Create an alias or reference of a logical path
   */
  copy(srcLogicalPath: string, destLogicalPath: string): void {
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
  delete(logicalPath: string, version: string = this.head): number {
    let count = 0;
    for (const lp of this._indexFindPaths(logicalPath, version)) {
      if (this.#unlist(lp, version)) {
        count++;
      }
    }
    return count;
  }

  reinstate(logicalPath: string, versionName: string): number {
    const names = this._indexFindPaths(logicalPath, versionName);
    let count = 0;
    for (const lp of names) {
      const digests = this._indexGet(lp, versionName);
      const digest = digests?.[this.digestAlgorithm];
      if (digests && digest) {
        if (this.getDigest(lp) !== digest) {
          this.delete(lp);
          this.#list(lp, digest, digests);
        }
        count++;
      }
    }
    return count;
  }
}

export { OcflObjectInventory, OcflObjectInventoryMut, VersionNumber };
