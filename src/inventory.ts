import path from 'node:path';
import { OcflError } from './error.ts';
import type { DeepReadonly, Digests, Inventory, InventoryDigests, InventoryVersion } from './types.ts';
import { createError } from './validation.ts';

export interface InventoryFile {
  logicalPath: string;
  version: string;
  digest: string;
  contentPath: string;
  fixity: Digests;
  size?: number;
  lastModified?: number;
}

/** Content paths are relative to the object root */
export interface ContentRelease {
  digest: string;
  from: string;
  /** Where the content moves to; undefined if nothing uses it any more */
  to?: string;
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

function findKey(file: string, obj: DeepReadonly<InventoryDigests>): string | undefined {
  for (const digest in obj) {
    if (obj[digest]?.includes(file)) {
      return digest;
    }
  }
}

function isNonEmpty<T>(arr: readonly T[] | undefined): arr is readonly [T, ...T[]] {
  return arr !== undefined && arr.length > 0;
}

function headNotInVersionsError(id: string, head: string) {
  return createError('E040', id, `head "${head}" is not in versions`);
}

function headVersion(data: Inventory): InventoryVersion {
  const version = data.versions[data.head];
  if (!version) {
    throw headNotInVersionsError(data.id, data.head);
  }
  return version;
}

/** Set by the read model's static block, so that only the write model can change an inventory's data */
let writableData: (inventory: OcflObjectInventory) => Inventory;

/**
 * Read-only wrapper class for inventory data
 */
class OcflObjectInventory {
  #data: Inventory;
  #fileIndex: { [version: string]: { [logicalPath: string]: Digests } } = {};
  #fixityIndex = new Map<string, Digests>();

  static {
    writableData = (inventory) => inventory.#data;
  }

  metadata: { [contentPath: string]: { size: number; lastModified: number } } | undefined;

  /**
   * Digest of this inventory's bytes in storage, as recorded in its sidecar
   * @internal
   */
  _digest: string | undefined;

  /**
   * Helper function to find the digest by logical file path and cached it by indexing
   * @internal
   */
  _indexGet(logicalPath: string, versionName?: string, onlyUsecache?: boolean): Digests | undefined {
    const version = this.#resolveVersion(versionName);
    let digests = this.#fileIndex[version]?.[logicalPath];
    if (!digests && !onlyUsecache) {
      // search and then index
      const algo = this.digestAlgorithm;
      const digestArr: [string, string][] = [];
      const mainDigest = findKey(logicalPath, this.versionState(version) ?? {});
      if (mainDigest) {
        digestArr.push([algo, mainDigest]);
        const cp = this.getContentPath(mainDigest);
        if (cp) {
          digestArr.push(...Object.entries(this._indexGetFixity(cp)));
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

  /** @internal */
  _indexAdd(logicalPath: string, version: string, digests: Digests) {
    this.#fileIndex[version] ??= {};
    this.#fileIndex[version][logicalPath] = digests;
  }

  /** @internal */
  _indexRemove(logicalPath: string) {
    delete this.#fileIndex[this.head]?.[logicalPath];
  }

  /** @internal */
  _indexGetFixity(contentPath: string): Digests {
    return this.#fixityIndex.get(contentPath) ?? {};
  }

  /**
   * A digest's file index entry, with the fixity of all its content paths
   * @internal
   */
  _indexDigests(digest: string): Digests {
    const digests: Digests = { [this.digestAlgorithm]: digest };
    for (const cp of this.#requireContentPaths(digest)) {
      Object.assign(digests, this._indexGetFixity(cp));
    }
    return digests;
  }

  /** @internal */
  _indexAddFixity(contentPath: string, algorithm: string, value: string) {
    let digests = this.#fixityIndex.get(contentPath);
    if (!digests) {
      digests = Object.create(null) as Digests;
      this.#fixityIndex.set(contentPath, digests);
    }
    digests[algorithm] = value;
  }

  /** @internal */
  _indexRemoveFixity(contentPath: string) {
    this.#fixityIndex.delete(contentPath);
  }

  /** @internal */
  _indexBuild() {
    this.#fixityIndex.clear();
    for (const [algorithm, digestBlock] of Object.entries(this.fixity ?? {})) {
      for (const [value, cps] of Object.entries(digestBlock)) {
        for (const cp of cps) {
          this._indexAddFixity(cp, algorithm, value);
        }
      }
    }
    // index logicalPaths
    // { v1: { 'dir/file.txt': { sha512: 'abcdef' } } }
    const index: { [version: string]: { [logicalPath: string]: Digests } } = {};
    this.#fileIndex = index;
    for (const [verName, ver] of Object.entries(this.versions)) {
      const indexVer: { [logicalPath: string]: Digests } = {};
      index[verName] = indexVer;
      for (const [digest, lps] of Object.entries(ver.state)) {
        for (const lp of lps) {
          indexVer[lp] = this._indexDigests(digest);
        }
      }
    }
  }

  /** @internal */
  _indexFindPaths(prefix: string, versionName?: string) {
    const res: string[] = [];
    const index = this.#fileIndex[this.#resolveVersion(versionName)];
    const prefixWithSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    for (const lp in index) {
      if (index[lp] && (lp === prefix || lp.startsWith(prefixWithSlash))) {
        res.push(lp);
      }
    }
    return res;
  }

  /**
   * Create a new inventory model
   * @param data - Initial data of the inventory
   */
  constructor(data: Inventory) {
    // an empty head is an inventory with no versions yet
    if (data.head !== '' && !data.versions?.[data.head]) {
      throw headNotInVersionsError(data.id, data.head);
    }
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
  get manifest(): DeepReadonly<InventoryDigests> {
    return this.#data.manifest;
  }
  get versions(): DeepReadonly<Inventory['versions']> {
    return this.#data.versions;
  }
  /** The current head version. Throws if the head is not in versions. */
  get version(): DeepReadonly<InventoryVersion> {
    return headVersion(this.#data);
  }
  get fixity(): DeepReadonly<Inventory['fixity']> {
    return this.#data.fixity;
  }
  /** The state of the current version */
  get state(): DeepReadonly<InventoryDigests> {
    return this.version.state;
  }
  get created(): string {
    return this.version.created;
  }
  get message(): InventoryVersion['message'] {
    return this.version.message;
  }
  get user(): DeepReadonly<InventoryVersion['user']> {
    return this.version.user;
  }
  //get nextVersion() { return this.versionNumber.next().toString(); }
  //get prevVersion() { return this.versionNumber.previous()?.toString(); }

  /**
   * Return the state of the specified version
   * @param versionName - The inventory version, default to the latest
   */
  versionState(versionName?: string): DeepReadonly<InventoryDigests> | undefined {
    return this.versions[this.#resolveVersion(versionName)]?.state;
  }

  #resolveVersion(versionName?: string): string {
    return versionName === undefined || versionName === 'latest' ? this.head : versionName;
  }

  toString() {
    return JSON.stringify(this.#data, null, 2);
  }

  toJSON(): Inventory {
    return JSON.parse(this.toString());
  }

  /**
   * @param versionName - The version name
   */
  *files(versionName?: string): Generator<InventoryFile> {
    const version = this.#resolveVersion(versionName);
    const state = version === this.head ? this.state : this.versionState(version);
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

  *find(fn: (file: InventoryFile) => boolean, version?: string) {
    for (const f of this.files(version)) {
      if (fn(f)) {
        yield f;
      }
    }
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

  #requireContentPaths(digest: string): readonly [string, ...string[]] {
    const cps = this.manifest[digest];
    if (!isNonEmpty(cps)) {
      throw createError('E050', this.id, `digest "${digest}" is not in the manifest`);
    }
    return cps;
  }

  /**
   * Get the digest of a content represented by the logicalPath of the specified version
   */
  getDigest(logicalPath: string, versionName?: string) {
    return this._indexGet(logicalPath, versionName, true)?.[this.digestAlgorithm];
  }

  /**
   * Get the file information by the logicalPath of the specified version
   */
  getFile(logicalPath: string, versionName?: string): InventoryFile | undefined {
    const version = this.#resolveVersion(versionName);
    const digest = this.getDigest(logicalPath, version);
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
    if (versionName !== undefined) {
      const logicalPath = this.versionState(versionName)?.[digest]?.[0];
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
  getFixity(logicalPath: string, versionName?: string): Digests {
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
    const diff = (s1: DeepReadonly<InventoryDigests>, s2: DeepReadonly<InventoryDigests>) => {
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

interface Transfer {
  src: string;
  dest: string;
  digest: string;
  digests: Digests;
}

interface RenamePlan {
  transfers: Transfer[];
  releases: ContentRelease[];
}

interface DeletePlan {
  paths: string[];
  releases: ContentRelease[];
}

/**
 * Wrapper class with mutable methods for inventory data
 */
class OcflObjectInventoryMut extends OcflObjectInventory {
  /**
   * Create a new mutable inventory from the object config or an existing inventory,
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

  get #writable(): Inventory {
    return writableData(this);
  }

  // An accessor pair replaces the inherited getter, so each setter needs its getter too
  get fixity(): DeepReadonly<Inventory['fixity']> {
    return super.fixity;
  }
  set fixity(val: NonNullable<Inventory['fixity']>) {
    this.#writable.fixity = val;
    this._indexBuild();
  }
  get created(): string {
    return super.created;
  }
  set created(val: string) {
    headVersion(this.#writable).created = val;
  }
  get message(): InventoryVersion['message'] {
    return super.message;
  }
  set message(val: NonNullable<InventoryVersion['message']>) {
    headVersion(this.#writable).message = val;
  }
  get user(): DeepReadonly<InventoryVersion['user']> {
    return super.user;
  }
  set user(val: NonNullable<InventoryVersion['user']>) {
    headVersion(this.#writable).user = val;
  }

  /** Return true if there has been actual change to the state of current version compared to the previous version */
  get isChanged(): boolean {
    const prev = this.versionNumber.previous()?.toString();
    if (!prev) {
      return true;
    }
    const diff = this.diffState(this.head, prev);
    return Object.keys(diff[0]).length > 0 || Object.keys(diff[1]).length > 0;
  }

  /** The digest of a logical path and the head state entry listing it */
  #stateEntry(logicalPath: string): { digest: string; files: string[] } | undefined {
    const digest = this.getDigest(logicalPath);
    const files = digest ? headVersion(this.#writable).state[digest] : undefined;
    return digest && files ? { digest, files } : undefined;
  }

  /**
   * Remove exactly one logical path from its digest's list in the head version state
   * @returns true if the path was listed
   */
  #unlist(logicalPath: string): boolean {
    const entry = this.#stateEntry(logicalPath);
    const index = entry?.files.indexOf(logicalPath) ?? -1;
    if (!entry || index < 0) {
      return false;
    }
    if (entry.files.length === 1) {
      delete headVersion(this.#writable).state[entry.digest];
    } else {
      entry.files.splice(index, 1);
    }
    this._indexRemove(logicalPath);
    return true;
  }

  /** Append a logical path to its digest's list in the head version state */
  #list(logicalPath: string, digest: string, digests: Digests) {
    const { state } = headVersion(this.#writable);
    state[digest] ??= [];
    state[digest].push(logicalPath);
    this._indexAdd(logicalPath, this.head, digests);
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @returns true if the state is changed
   */
  add(logicalPath: string, digest: string, fixity?: { [x: string]: string }): boolean {
    if (this.getDigest(logicalPath) !== digest) {
      const releases = this._contentReleases([logicalPath]);
      this.#unlist(logicalPath);
      this.#applyContentReleases(releases);
    }
    const existingPath = this.getContentPath(digest);
    const digests = existingPath ? this.#fillFixity(existingPath, digest, fixity) : this.#addContent(logicalPath, digest, fixity);
    if (this.getDigest(logicalPath) === digest) {
      return false;
    }
    this.#list(logicalPath, digest, digests);
    return true;
  }

  #ownContentPath(logicalPath: string) {
    return `${this.head}/${this.contentDirectory}/${logicalPath}`;
  }

  /**
   * What happens to the content of logical paths once they all stop using it, for content this version stored
   * @internal
   */
  _contentReleases(logicalPaths: string[]): ContentRelease[] {
    const leaving = new Set(logicalPaths);
    const ownPaths = new Set(logicalPaths.map((logicalPath) => this.#ownContentPath(logicalPath)));
    const digests = new Set(logicalPaths.map((logicalPath) => this.getDigest(logicalPath)).filter((digest) => digest !== undefined));
    return [...digests].flatMap((digest) => {
      const from = this.getContentPath(digest);
      if (!from?.startsWith(`${this.head}/`)) {
        return [];
      }
      const heir = this.state[digest]?.find((file) => !leaving.has(file));
      if (heir === undefined) {
        return [{ digest, from }];
      }
      return ownPaths.has(from) ? [{ digest, from, to: this.#ownContentPath(heir) }] : [];
    });
  }

  /** The state must already be free of any digest a release removes, because recording fixity can rebuild the index from it */
  #applyContentReleases(releases: ContentRelease[]) {
    for (const { digest, from, to } of releases) {
      if (to === undefined) {
        delete this.#writable.manifest[digest];
        this.#forgetFixity(from);
      } else {
        this.#moveContent(digest, from, to);
      }
    }
  }

  #moveContent(digest: string, from: string, to: string) {
    const fixity = Object.entries(this._indexGetFixity(from));
    this.#forgetFixity(from);
    this.#writable.manifest[digest] = [to];
    for (const [algorithm, value] of fixity) {
      this.#addFixity(to, algorithm, value);
    }
  }

  #forgetFixity(contentPath: string) {
    const { fixity } = this.#writable;
    for (const [algorithm, value] of Object.entries(this._indexGetFixity(contentPath))) {
      const block = fixity?.[algorithm];
      const contentPaths = block?.[value]?.filter((p) => p !== contentPath);
      if (block && contentPaths?.length) {
        block[value] = contentPaths;
      } else if (block) {
        delete block[value];
      }
      if (block && Object.keys(block).length === 0) {
        delete fixity?.[algorithm];
      }
    }
    this._indexRemoveFixity(contentPath);
  }

  #addContent(logicalPath: string, digest: string, fixity: Digests = {}): Digests {
    const contentPath = this.#ownContentPath(logicalPath);
    this.#writable.manifest[digest] = [contentPath];
    for (const [digestName, digestValue] of Object.entries(fixity)) {
      this.#addFixity(contentPath, digestName, digestValue);
    }
    return { [this.digestAlgorithm]: digest, ...fixity };
  }

  /** Record values for the algorithms a content path has none for, keeping any it already has */
  #fillFixity(contentPath: string, digest: string, fixity: Digests = {}): Digests {
    const recorded = this._indexGetFixity(contentPath);
    const missing = Object.entries(fixity).filter(([digestName]) => !recorded[digestName]);
    for (const [digestName, digestValue] of missing) {
      this.#addFixity(contentPath, digestName, digestValue);
    }
    const digests = this._indexDigests(digest);
    if (missing.length > 0) {
      for (const [version, { state }] of Object.entries(this.versions)) {
        for (const logicalPath of state[digest] ?? []) {
          this._indexAdd(logicalPath, version, digests);
        }
      }
    }
    return digests;
  }

  /**
   * Low-level method to add a set of digest entries associated to file into the fixity block
   */
  #addFixity(contentPath: string, digestName: string, digestValue: string) {
    if (!digestValue || !digestName) {
      return;
    }
    const data = this.#writable;
    data.fixity ??= {};
    data.fixity[digestName] ??= {};
    const digestBlock = data.fixity[digestName];
    if (digestBlock[digestValue]) {
      if (!digestBlock[digestValue].includes(contentPath)) {
        digestBlock[digestValue].push(contentPath);
      }
    } else {
      digestBlock[digestValue] = [contentPath];
    }
    this._indexAddFixity(contentPath, digestName, digestValue);
  }

  /** True if a file or directory occupies the path, or the path is inside a file, in the head state */
  #isOccupied(logicalPath: string) {
    if (this._indexFindPaths(logicalPath).length > 0) {
      return true;
    }
    const segments = logicalPath.split('/');
    return segments.some((_, depth) => depth > 0 && this.getDigest(segments.slice(0, depth).join('/')));
  }

  /**
   * Resolve a copy or rename to the files it transfers, changing nothing.
   * @throws OcflError FILE_NOT_FOUND if the source is missing, FILE_EXISTS if the target exists
   */
  #planTransfer(srcLogicalPath: string, destLogicalPath: string): Transfer[] {
    // Filesystem paths are normalised, so the check and the state must use the same form as the file on disk
    const target = path.posix.normalize(destLogicalPath).replace(/\/$/, '');
    const srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : `${srcLogicalPath}/`;
    const srcList = this._indexFindPaths(srcPrefix);
    const pairs = srcList.map((src): [string, string] => [src, `${target}/${src.slice(srcPrefix.length)}`]);
    if (pairs.length === 0) {
      pairs.push([srcLogicalPath, target]);
    }
    const transfers = pairs.map(([src, dest]) => {
      const digests = this._indexGet(src, this.head, true);
      const digest = digests?.[this.digestAlgorithm];
      if (!digests || !digest) {
        throw new OcflError('FILE_NOT_FOUND', `Source logical path "${src}" does not exist in object [${this.id}]`);
      }
      return { src, dest, digest, digests };
    });
    if (!target || target === '.') {
      throw new Error(`Target logical path cannot be empty`);
    }
    if (this.#isOccupied(target)) {
      throw new OcflError('FILE_EXISTS', `Target logical path "${destLogicalPath}" already exists in object [${this.id}]`);
    }
    return transfers;
  }

  /**
   * Rename a logical path or directory
   * @throws OcflError FILE_EXISTS if the target exists
   */
  rename(srcLogicalPath: string, destLogicalPath: string) {
    this._applyRename(this._planRename(srcLogicalPath, destLogicalPath));
  }

  /**
   * Resolve a rename to its transfers and the content it moves, changing nothing. Only files this
   * version stored at a source's own content path move.
   * @throws OcflError FILE_NOT_FOUND if the source is missing, FILE_EXISTS if the target exists
   * @internal
   */
  _planRename(srcLogicalPath: string, destLogicalPath: string): RenamePlan {
    const transfers = this.#planTransfer(srcLogicalPath, destLogicalPath);
    const releases = transfers.flatMap(({ src, dest, digest }) => {
      const from = this.getContentPath(digest);
      return from === this.#ownContentPath(src) ? [{ digest, from, to: this.#ownContentPath(dest) }] : [];
    });
    return { transfers, releases };
  }

  /**
   * Apply a plan from {@link _planRename}, which must be from the current head state
   * @internal
   */
  _applyRename({ transfers, releases }: RenamePlan) {
    this.#applyContentReleases(releases);
    for (const { src, dest, digest, digests } of transfers) {
      this.#unlist(src);
      this.#list(dest, digest, digests);
    }
  }

  /**
   * Create an alias or reference of a logical path or directory
   * @throws OcflError FILE_EXISTS if the target exists
   */
  copy(srcLogicalPath: string, destLogicalPath: string) {
    for (const { dest, digest, digests } of this.#planTransfer(srcLogicalPath, destLogicalPath)) {
      this.#list(dest, digest, digests);
    }
  }

  /**
   * Delete a file or directory. Content the head version stored moves to a remaining logical path
   * that uses it, or leaves the manifest if none does.
   */
  delete(logicalPath: string) {
    return this._applyDelete(this._planDelete(logicalPath));
  }

  /**
   * Resolve a delete to the paths it unlists and what happens to their content, changing nothing
   * @internal
   */
  _planDelete(logicalPath: string): DeletePlan {
    const paths = this._indexFindPaths(logicalPath);
    return { paths, releases: this._contentReleases(paths) };
  }

  /**
   * Apply a plan from {@link _planDelete}, which must be from the current state
   * @internal
   */
  _applyDelete({ paths, releases }: DeletePlan) {
    const count = this.#delist(paths);
    this.#applyContentReleases(releases);
    return count;
  }

  #delist(logicalPaths: string[]) {
    let count = 0;
    for (const lp of logicalPaths) {
      if (this.#unlist(lp)) {
        count++;
      }
    }
    return count;
  }

  reinstate(logicalPath: string, versionName: string) {
    const names = this._indexFindPaths(logicalPath, versionName);
    let count = 0;
    for (const lp of names) {
      const digests = this._indexGet(lp, versionName);
      const digest = digests?.[this.digestAlgorithm];
      if (digests && digest) {
        if (this.getDigest(lp) !== digest) {
          this.#delist(this._indexFindPaths(lp));
          this.#list(lp, digest, digests);
        }
        count++;
      }
    }
    return count;
  }
}

export { OcflObjectInventory, OcflObjectInventoryMut, VersionNumber };
