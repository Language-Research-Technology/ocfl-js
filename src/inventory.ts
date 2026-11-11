import { OcflError } from './error.ts';
import type { ContentAlgorithm, DeepReadonly, Digests, Inventory, InventoryDigests, InventoryVersion } from './types.ts';
import { normaliseLogicalPath, parentDirectories } from './utils.ts';
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
  private constructor(num: number, zeroPaddingLength?: number) {
    this.value = num;
    this.zeroPaddingLength = zeroPaddingLength;
  }
  valueOf(): number {
    return this.value;
  }
  toString(): string {
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
  /** @internal */
  static fromString(versionLabel: string): VersionNumber {
    const label = versionLabel.replace('v', '');
    let zeroPaddingLength: number | undefined;
    if (label.startsWith('0')) {
      zeroPaddingLength = label.length;
    }
    return new VersionNumber(parseInt(label, 10), zeroPaddingLength);
  }

  /** @internal */
  static next(versionLabel: string): VersionNumber {
    return VersionNumber.fromString(versionLabel).next();
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

/** Whether `name` is a version directory name, such as `v1` or `v001` */
function isVersionName(name: string): boolean {
  return /^v(?:[1-9]\d*|0\d*[1-9]\d*)$/.test(name);
}

/**
 * Checks an inventory read from storage, before its values are used as paths in the object root.
 * The constructor checks that `head` is one of the versions.
 * @param file - The inventory's path, for the error
 * @throws `ValidationError` `E036` or `E040` for a missing or empty head, `E104` for a version name,
 * `E017` or `E018` for the contentDirectory, or `E099` or `E100` for a content path
 */
function validateStoredInventory(data: Inventory, file: string): void {
  if (data.head === undefined) {
    throw createError('E036', file, 'missing head');
  }
  if (data.head === '') {
    throw createError('E040', file, 'empty head');
  }
  for (const name of Object.keys(data.versions ?? {})) {
    if (!isVersionName(name)) {
      throw createError('E104', file, `version "${name}"`);
    }
  }
  const { contentDirectory } = data;
  if (typeof contentDirectory === 'string') {
    if (contentDirectory.includes('/')) {
      throw createError('E017', file, `contentDirectory "${contentDirectory}"`);
    }
    if (contentDirectory === '.' || contentDirectory === '..') {
      throw createError('E018', file, `contentDirectory "${contentDirectory}"`);
    }
  }
  for (const contentPaths of Object.values(data.manifest)) {
    for (const contentPath of contentPaths) {
      if (contentPath.startsWith('/') || contentPath.endsWith('/')) {
        throw createError('E100', file, `content path "${contentPath}"`);
      }
      if (contentPath.split('/').some((element) => element === '' || element === '.' || element === '..')) {
        throw createError('E099', file, `content path "${contentPath}"`);
      }
    }
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

export interface DeletePlan {
  paths: string[];
  releases: ContentRelease[];
}

interface ReinstatePlan extends DeletePlan {
  files: { logicalPath: string; digest: string; digests: Digests }[];
  /** Paths found in the earlier version, including those already the same in the head */
  count: number;
}

/**
 * An OCFL object's inventory. Only a transaction changes it, while it builds a new version.
 */
class OcflObjectInventory {
  #data: Inventory;
  #fileIndex: { [version: string]: { [logicalPath: string]: Digests } } = {};
  #fixityIndex = new Map<string, Digests>();
  /** How many files each directory of the head state contains, at any depth */
  #headDirectories = new Map<string, number>();

  metadata: { [contentPath: string]: { size: number; lastModified: number } } | undefined;

  /**
   * Digest of this inventory's bytes in storage, as recorded in its sidecar
   * @internal
   */
  _digest: string | undefined;

  /**
   * Helper function to find the digest by logical file path and cached it by indexing
   */
  #indexGet(logicalPath: string, versionName?: string, onlyUsecache?: boolean): Digests | undefined {
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
          digestArr.push(...Object.entries(this.#indexGetFixity(cp)));
        }
      }
      if (digestArr.length > 0) {
        digests = Object.fromEntries(digestArr);
        this.#indexAdd(logicalPath, version, digests);
      }
    }
    return digests;
  }

  #indexAdd(logicalPath: string, version: string, digests: Digests) {
    this.#fileIndex[version] ??= {};
    const index = this.#fileIndex[version];
    if (version === this.head && !index[logicalPath]) {
      this.#adjustDirectoryCounts(logicalPath, 1);
    }
    index[logicalPath] = digests;
  }

  #indexRemove(logicalPath: string) {
    const index = this.#fileIndex[this.head];
    if (index?.[logicalPath]) {
      this.#adjustDirectoryCounts(logicalPath, -1);
      delete index[logicalPath];
    }
  }

  #adjustDirectoryCounts(logicalPath: string, change: number) {
    for (const directory of parentDirectories(logicalPath)) {
      const count = (this.#headDirectories.get(directory) ?? 0) + change;
      if (count > 0) {
        this.#headDirectories.set(directory, count);
      } else {
        this.#headDirectories.delete(directory);
      }
    }
  }

  #indexGetFixity(contentPath: string): Digests {
    return this.#fixityIndex.get(contentPath) ?? {};
  }

  /**
   * A digest's file index entry, with the fixity of all its content paths
   */
  #indexDigests(digest: string): Digests {
    const digests: Digests = { [this.digestAlgorithm]: digest };
    for (const cp of this.#requireContentPaths(digest)) {
      Object.assign(digests, this.#indexGetFixity(cp));
    }
    return digests;
  }

  #indexAddFixity(contentPath: string, algorithm: string, value: string) {
    let digests = this.#fixityIndex.get(contentPath);
    if (!digests) {
      digests = Object.create(null) as Digests;
      this.#fixityIndex.set(contentPath, digests);
    }
    digests[algorithm] = value;
  }

  #indexRemoveFixity(contentPath: string) {
    this.#fixityIndex.delete(contentPath);
  }

  #indexBuild() {
    this.#fixityIndex.clear();
    for (const [algorithm, digestBlock] of Object.entries(this.fixity ?? {})) {
      for (const [value, cps] of Object.entries(digestBlock)) {
        for (const cp of cps) {
          this.#indexAddFixity(cp, algorithm, value);
        }
      }
    }
    // index logicalPaths
    // { v1: { 'dir/file.txt': { sha512: 'abcdef' } } }
    this.#fileIndex = {};
    this.#headDirectories.clear();
    for (const [verName, ver] of Object.entries(this.versions)) {
      this.#fileIndex[verName] = {};
      for (const [digest, lps] of Object.entries(ver.state)) {
        for (const lp of lps) {
          this.#indexAdd(lp, verName, this.#indexDigests(digest));
        }
      }
    }
  }

  #indexFindPaths(prefix: string, versionName?: string) {
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
    this.#indexBuild();
  }

  get id(): string {
    return this.#data.id;
  }
  get type(): Inventory['type'] {
    return this.#data.type;
  }
  get digestAlgorithm(): ContentAlgorithm {
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

  toString(): string {
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

  *find(fn: (file: InventoryFile) => boolean, version?: string): Generator<InventoryFile, void, unknown> {
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
  getDigest(logicalPath: string, versionName?: string): string | undefined {
    return this.#indexGet(logicalPath, versionName, true)?.[this.digestAlgorithm];
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
    const { [this.digestAlgorithm]: digest, ...fixity } = this.#indexGet(logicalPath, versionName, true) || {};
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

  /**
   * Create an inventory for a new version, from the object config or a copy of an existing inventory.
   * If data.head is undefined, starts from v1.
   * @internal
   */
  static newVersion(data: Partial<Inventory> | OcflObjectInventory, cleanState?: boolean): OcflObjectInventory {
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
    return new OcflObjectInventory(data as Inventory);
  }

  /**
   * Record when the head version was created, and its message and user if given
   * @internal
   */
  _stamp(created: string, message?: InventoryVersion['message'], user?: InventoryVersion['user']) {
    const version = headVersion(this.#data);
    version.created = created;
    if (message) {
      version.message = message;
    }
    if (user) {
      version.user = user;
    }
  }

  /**
   * Whether the head version's state differs from the previous version's
   * @internal
   */
  get _isChanged(): boolean {
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
    const files = digest ? headVersion(this.#data).state[digest] : undefined;
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
      delete headVersion(this.#data).state[entry.digest];
    } else {
      entry.files.splice(index, 1);
    }
    this.#indexRemove(logicalPath);
    return true;
  }

  /** Append a logical path to its digest's list in the head version state */
  #list(logicalPath: string, digest: string, digests: Digests) {
    const { state } = headVersion(this.#data);
    state[digest] ??= [];
    state[digest].push(logicalPath);
    this.#indexAdd(logicalPath, this.head, digests);
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @returns true if the state is changed
   * @throws {@link OcflError} `FILE_EXISTS` if the path is a directory, or is inside a file
   * @internal
   */
  _add(logicalPath: string, digest: string): boolean {
    this._checkFilePath(logicalPath);
    if (this.getDigest(logicalPath) !== digest) {
      const releases = this._contentReleases([logicalPath]);
      this.#unlist(logicalPath);
      this.#applyContentReleases(releases);
    }
    const existingPath = this.getContentPath(digest);
    const digests = existingPath ? this.#fillFixity(existingPath, digest) : this.#addContent(logicalPath, digest);
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
        delete this.#data.manifest[digest];
        this.#forgetFixity(from);
      } else {
        this.#moveContent(digest, from, to);
      }
    }
  }

  #moveContent(digest: string, from: string, to: string) {
    const fixity = Object.entries(this.#indexGetFixity(from));
    this.#forgetFixity(from);
    this.#data.manifest[digest] = [to];
    for (const [algorithm, value] of fixity) {
      this.#addFixity(to, algorithm, value);
    }
  }

  #forgetFixity(contentPath: string) {
    const { fixity } = this.#data;
    for (const [algorithm, value] of Object.entries(this.#indexGetFixity(contentPath))) {
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
    this.#indexRemoveFixity(contentPath);
  }

  #addContent(logicalPath: string, digest: string, fixity: Digests = {}): Digests {
    const contentPath = this.#ownContentPath(logicalPath);
    this.#data.manifest[digest] = [contentPath];
    for (const [digestName, digestValue] of Object.entries(fixity)) {
      this.#addFixity(contentPath, digestName, digestValue);
    }
    return { [this.digestAlgorithm]: digest, ...fixity };
  }

  /** Record values for the algorithms a content path has none for, keeping any it already has */
  #fillFixity(contentPath: string, digest: string, fixity: Digests = {}): Digests {
    const recorded = this.#indexGetFixity(contentPath);
    const missing = Object.entries(fixity).filter(([digestName]) => !recorded[digestName]);
    for (const [digestName, digestValue] of missing) {
      this.#addFixity(contentPath, digestName, digestValue);
    }
    const digests = this.#indexDigests(digest);
    if (missing.length > 0) {
      for (const [version, { state }] of Object.entries(this.versions)) {
        for (const logicalPath of state[digest] ?? []) {
          this.#indexAdd(logicalPath, version, digests);
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
    const data = this.#data;
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
    this.#indexAddFixity(contentPath, digestName, digestValue);
  }

  /** True if the path is inside a file in the head state */
  #isInsideFile(logicalPath: string) {
    return parentDirectories(logicalPath).some((directory) => this.getDigest(directory));
  }

  /** @throws {@link OcflError} `FILE_EXISTS` if the path is inside a file in the head state */
  #checkNotInsideFile(logicalPath: string) {
    if (this.#isInsideFile(logicalPath)) {
      throw new OcflError('FILE_EXISTS', `Logical path "${logicalPath}" is inside an existing file in object [${this.id}]`);
    }
  }

  /** True if a file or directory occupies the path, or the path is inside a file, in the head state */
  #isOccupied(logicalPath: string) {
    return this.getDigest(logicalPath) !== undefined || this.#headDirectories.has(logicalPath) || this.#isInsideFile(logicalPath);
  }

  /**
   * Check a file can be listed at the path, replacing any file already there
   * @throws {@link OcflError} `FILE_EXISTS` if the path is a directory, or is inside a file, in the head state
   * @internal
   */
  _checkFilePath(logicalPath: string) {
    const target = normaliseLogicalPath(logicalPath);
    this.#checkNotInsideFile(target);
    if (this.#headDirectories.has(target)) {
      throw new OcflError('FILE_EXISTS', `Logical path "${logicalPath}" is an existing directory in object [${this.id}]`);
    }
  }

  /**
   * Resolve a copy or rename to the files it transfers, changing nothing.
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the source is missing, `FILE_EXISTS` if the target exists
   */
  #planTransfer(srcLogicalPath: string, destLogicalPath: string): Transfer[] {
    // Filesystem paths are normalised, so the check and the state must use the same form as the file on disk
    const target = normaliseLogicalPath(destLogicalPath);
    const srcPrefix = srcLogicalPath.endsWith('/') ? srcLogicalPath : `${srcLogicalPath}/`;
    const srcList = this.#indexFindPaths(srcPrefix);
    const pairs = srcList.map((src): [string, string] => [src, `${target}/${src.slice(srcPrefix.length)}`]);
    if (pairs.length === 0) {
      pairs.push([srcLogicalPath, target]);
    }
    const transfers = pairs.map(([src, dest]) => {
      const digests = this.#indexGet(src, this.head, true);
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
   * @throws {@link OcflError} `FILE_EXISTS` if the target exists
   * @internal
   */
  _rename(srcLogicalPath: string, destLogicalPath: string): void {
    this._applyRename(this._planRename(srcLogicalPath, destLogicalPath));
  }

  /**
   * Resolve a rename to its transfers and the content it moves, changing nothing. Only files this
   * version stored at a source's own content path move.
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the source is missing, `FILE_EXISTS` if the target exists
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
   * @throws {@link OcflError} `FILE_EXISTS` if the target exists
   * @internal
   */
  _copy(srcLogicalPath: string, destLogicalPath: string): void {
    for (const { dest, digest, digests } of this.#planTransfer(srcLogicalPath, destLogicalPath)) {
      this.#list(dest, digest, digests);
    }
  }

  /**
   * Delete a file or directory. Content the head version stored moves to a remaining logical path
   * that uses it, or leaves the manifest if none does.
   * @internal
   */
  _delete(logicalPath: string): number {
    return this._applyDelete(this._planDelete(logicalPath));
  }

  /**
   * Resolve a delete to the paths it unlists and what happens to their content, changing nothing
   * @internal
   */
  _planDelete(logicalPath: string): DeletePlan {
    const paths = this.#indexFindPaths(logicalPath);
    return { paths, releases: this._contentReleases(paths) };
  }

  /**
   * {@link _planDelete} for every file
   * @internal
   */
  _planClear(): DeletePlan {
    const paths = Object.values(this.state).flat();
    return { paths, releases: this._contentReleases(paths) };
  }

  /**
   * Apply a plan from {@link _planDelete} or {@link _planClear}, which must be from the current state
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

  /** @internal */
  _reinstate(logicalPath: string, versionName: string): number {
    return this._applyReinstate(this._planReinstate(logicalPath, versionName));
  }

  /**
   * Resolve a reinstate to the files it lists, the paths they replace and what happens to the
   * replaced paths' content, changing nothing
   * @throws {@link OcflError} `FILE_EXISTS` if a file it lists is inside a file in the head state
   * @internal
   */
  _planReinstate(logicalPath: string, versionName: string): ReinstatePlan {
    const files: ReinstatePlan['files'] = [];
    let count = 0;
    for (const lp of this.#indexFindPaths(logicalPath, versionName)) {
      const digests = this.#indexGet(lp, versionName);
      const digest = digests?.[this.digestAlgorithm];
      if (digests && digest) {
        if (this.getDigest(lp) !== digest) {
          this.#checkNotInsideFile(lp);
          files.push({ logicalPath: lp, digest, digests });
        }
        count++;
      }
    }
    const paths = [...new Set(files.flatMap((file) => this.#indexFindPaths(file.logicalPath)))];
    return { files, paths, releases: this._contentReleases(paths), count };
  }

  /**
   * Apply a plan from {@link _planReinstate}, which must be from the current state
   * @internal
   */
  _applyReinstate({ files, paths, releases, count }: ReinstatePlan) {
    this.#delist(paths);
    this.#applyContentReleases(releases);
    for (const { logicalPath, digest, digests } of files) {
      this.#list(logicalPath, digest, digests);
    }
    return count;
  }
}

export { isVersionName, OcflObjectInventory, VersionNumber, validateStoredInventory };
