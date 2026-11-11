import nodePath from 'node:path';
import { OcflConstants } from './constants.ts';
import { ocflError } from './error.ts';
import type { ContentAlgorithm, DeepReadonly, Digests, Inventory, InventoryDigests, InventoryVersion } from './types.ts';
import { normaliseLogicalPath, parentDirectories } from './utils.ts';
import { createError } from './validation.ts';

const { INVENTORY_NAME } = OcflConstants;

interface InventoryFile {
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
  toString(): string {
    return `v${this.zeroPaddingLength ? `${this.value}`.padStart(this.zeroPaddingLength, '0') : this.value}`;
  }
  /** @throws {@link OcflError} `VERSION_LIMIT_REACHED` if the next name, padded, wouldn't start with a zero (E011) */
  next(): VersionNumber {
    const next = new VersionNumber(this.value + 1, this.zeroPaddingLength);
    if (this.zeroPaddingLength && `${next.value}`.length >= this.zeroPaddingLength) {
      throw ocflError(
        'VERSION_LIMIT_REACHED',
        `There can be no version after ${this}: a zero-padded version name must start with a zero (E011), and one of ${this.zeroPaddingLength} digits can't for ${next.value}.`,
      );
    }
    return next;
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

  /**
   * The number of `versionLabel` among `versionNames`, which are padded to one width if any of them has a leading zero
   * @internal
   */
  static _among(versionLabel: string, versionNames: string[]): VersionNumber {
    const padded = versionNames.find((name) => name.startsWith('v0'));
    return new VersionNumber(VersionNumber.fromString(versionLabel).value, padded ? VersionNumber.fromString(padded).zeroPaddingLength : undefined);
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

/** The digest an inventory sidecar records, if it records one */
function sidecarDigest(sidecar: string | undefined): string | undefined {
  return sidecar?.match(/\S+/)?.[0];
}

/** What the sidecar of `inventory` holds, once its digest is known */
function sidecarContent(inventory: OcflObjectInventory): string {
  return `${inventory._digest} ${INVENTORY_NAME}`;
}

/** The root inventory and its sidecar, and where a commit stages each before renaming it into place */
function rootInventoryPaths(objectRoot: string, digestAlgorithm: string): Record<'inventory' | 'sidecar' | 'stagedInventory' | 'stagedSidecar', string> {
  const inventory = nodePath.join(objectRoot, INVENTORY_NAME);
  const sidecar = `${inventory}.${digestAlgorithm}`;
  return { inventory, sidecar, stagedInventory: `${inventory}.tmp`, stagedSidecar: `${sidecar}.tmp` };
}

/** Whether `name` is a staged file of {@link rootInventoryPaths}, for any digest algorithm */
function isStagedRootInventory(name: string): boolean {
  return /^inventory\.json(\.[^.]+)?\.tmp$/.test(name);
}

/**
 * Checks an inventory read from storage, before its values are used as paths in the object root.
 * The constructor checks that `head` is one of the versions.
 * @param file - The inventory's path, for the error
 * @throws {@link OcflError} `INVALID_OBJECT` with `E036` or `E040` for a missing or empty head, `E104` for a version name,
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

/** A copy or rename resolved to its files */
interface TransferPlan {
  transfers: Transfer[];
  /** Files now at a `dest` that hold other content, which the transfer replaces */
  replaced: string[];
}

export interface DeletePlan {
  paths: string[];
  releases: ContentRelease[];
}

/** A copy, rename or reinstate: the paths it unlists, then the files it lists */
export interface RelistPlan extends DeletePlan {
  files: { logicalPath: string; digest: string; digests: Digests }[];
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
   * The {@link _digest} of the inventory this one is the next version of
   * @internal
   */
  _madeFrom: string | undefined;

  /** The digests the index holds for a logical path */
  #indexGet(logicalPath: string, versionName?: string): Digests | undefined {
    return this.#fileIndex[this.#resolveVersion(versionName)]?.[logicalPath];
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
        const digests = this.#indexDigests(digest);
        for (const lp of lps) {
          this.#indexAdd(lp, verName, digests);
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
    return VersionNumber._among(this.head, Object.keys(this.#data.versions));
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

  /** The name of committed version `version`, if there is one */
  #committedVersionName(version: number): string | undefined {
    return Object.keys(this.versions).find((name) => name !== this.head && VersionNumber.fromString(name).value === version);
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
    return this.#indexGet(logicalPath, versionName)?.[this.digestAlgorithm];
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
    const { [this.digestAlgorithm]: digest, ...fixity } = this.#indexGet(logicalPath, versionName) || {};
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
    const madeFrom = data instanceof OcflObjectInventory ? data._digest : undefined;
    if (data instanceof OcflObjectInventory) {
      data = JSON.parse(JSON.stringify(data.#data)) as Inventory;
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
      data.head = VersionNumber._among(data.head, Object.keys(data.versions)).next().toString();
    } else {
      data.head = 'v1';
    }
    data.versions[data.head] = {
      created: new Date().toISOString(),
      state,
    };
    const next = new OcflObjectInventory(data as Inventory);
    next._madeFrom = madeFrom;
    return next;
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
    const digests = existingPath ? this.#indexDigests(digest) : this.#addContent(logicalPath, digest);
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
   * What happens to the content of logical paths once they all stop using it, for content this version stored.
   * Content stored at a leaving path's own content path follows that path if it is transferred, or else moves
   * to a path that still uses it. A release can move content to a path another release vacates.
   * @param arriving - Transfers that list their destinations once `logicalPaths` are unlisted
   * @internal
   */
  _contentReleases(logicalPaths: string[], arriving: Transfer[] = []): ContentRelease[] {
    const leaving = new Set(logicalPaths);
    const ownPaths = new Set(logicalPaths.map((logicalPath) => this.#ownContentPath(logicalPath)));
    const digests = new Set(logicalPaths.map((logicalPath) => this.getDigest(logicalPath)).filter((digest) => digest !== undefined));
    const arrivalsOf = Map.groupBy(arriving, (transfer) => transfer.digest);
    return [...digests].flatMap((digest) => {
      const from = this.getContentPath(digest);
      if (!from?.startsWith(`${this.head}/`)) {
        return [];
      }
      const arrivals = arrivalsOf.get(digest) ?? [];
      const follows = arrivals.find(({ src }) => this.#ownContentPath(src) === from);
      const heirs = [
        ...(follows ? [follows.dest] : []),
        ...(this.state[digest] ?? []).filter((file) => !leaving.has(file)),
        ...arrivals.map(({ dest }) => dest),
      ];
      const [heir] = heirs;
      if (heir === undefined) {
        return [{ digest, from }];
      }
      const stays = !ownPaths.has(from) || heirs.some((file) => this.#ownContentPath(file) === from);
      return stays ? [] : [{ digest, from, to: this.#ownContentPath(heir) }];
    });
  }

  #applyContentReleases(releases: ContentRelease[]) {
    // Every `from` is read and forgotten first: a release can move content to a path another vacates
    const released = releases.map((release) => ({ ...release, fixity: Object.entries(this.#indexGetFixity(release.from)) }));
    for (const { from } of released) {
      this.#forgetFixity(from);
    }
    for (const { digest, to, fixity } of released) {
      if (to === undefined) {
        delete this.#data.manifest[digest];
        continue;
      }
      this.#data.manifest[digest] = [to];
      for (const [algorithm, value] of fixity) {
        this.#addFixity(to, algorithm, value);
      }
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

  #addContent(logicalPath: string, digest: string): Digests {
    this.#data.manifest[digest] = [this.#ownContentPath(logicalPath)];
    return { [this.digestAlgorithm]: digest };
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
      throw ocflError('FILE_EXISTS', `Logical path "${logicalPath}" is inside an existing file in object [${this.id}]`);
    }
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
      throw ocflError('FILE_EXISTS', `Logical path "${logicalPath}" is an existing directory in object [${this.id}]`);
    }
  }

  /**
   * Resolve a copy or rename to the files it transfers and the files they replace, changing nothing.
   * @throws {@link OcflError} `FILE_NOT_FOUND`, `FILE_EXISTS` or `INVALID_LOGICAL_PATH`
   */
  #planTransfer(source: string, target: string, merge: boolean): TransferPlan {
    const src = normaliseLogicalPath(source);
    const dest = normaliseLogicalPath(target);
    for (const logicalPath of [src, dest]) {
      if (logicalPath === '.') {
        throw ocflError('INVALID_LOGICAL_PATH', "A logical path can't be empty");
      }
    }
    const isFile = this.getDigest(src) !== undefined;
    const sources = isFile ? [src] : this.#indexFindPaths(src);
    if (sources.length === 0) {
      throw ocflError('FILE_NOT_FOUND', `Source logical path "${source}" does not exist in object [${this.id}]`);
    }
    if (src === dest) {
      return { transfers: [], replaced: [] };
    }
    if (dest.startsWith(`${src}/`)) {
      throw ocflError('INVALID_LOGICAL_PATH', `Target logical path "${target}" is inside the source "${source}"`);
    }
    if (!isFile) {
      this.#checkNotInsideFile(dest);
      if (this.getDigest(dest) !== undefined) {
        throw ocflError('FILE_EXISTS', `Target logical path "${target}" is an existing file in object [${this.id}]`);
      }
      if (!merge && this.#headDirectories.has(dest)) {
        throw ocflError('FILE_EXISTS', `Target logical path "${target}" already has files in object [${this.id}]`);
      }
    }
    const transfers = sources.flatMap((file) => {
      const digests = this.#indexGet(file, this.head);
      const digest = digests?.[this.digestAlgorithm];
      return digests && digest ? [{ src: file, dest: `${dest}${file.slice(src.length)}`, digest, digests }] : [];
    });
    for (const transfer of transfers) {
      this._checkFilePath(transfer.dest);
    }
    const replaced = transfers
      .filter(({ dest, digest }) => {
        const held = this.getDigest(dest);
        return held !== undefined && held !== digest;
      })
      .map(({ dest }) => dest);
    return { transfers, replaced };
  }

  /**
   * @param unlisted - The paths the transfers unlist
   * @returns The plan that unlists them, then lists each destination that doesn't still hold its content
   */
  #relistPlan(transfers: Transfer[], unlisted: string[]): RelistPlan {
    const leaving = new Set(unlisted);
    const paths = [...leaving];
    const files = transfers
      .filter(({ dest, digest }) => leaving.has(dest) || this.getDigest(dest) !== digest)
      .map(({ dest, digest, digests }) => ({ logicalPath: dest, digest, digests }));
    return { paths, files, releases: this._contentReleases(paths, transfers) };
  }

  /**
   * Resolve a rename to the paths it unlists, the files it lists and what happens to stored content,
   * changing nothing. Only files this version stored at a source's or a replaced file's own content path move.
   * @throws {@link OcflError} `FILE_NOT_FOUND`, `FILE_EXISTS` or `INVALID_LOGICAL_PATH`
   * @internal
   */
  _planRename(source: string, target: string, merge = false): RelistPlan {
    const { transfers, replaced } = this.#planTransfer(source, target, merge);
    return this.#relistPlan(transfers, [...replaced, ...transfers.map(({ src }) => src)]);
  }

  /**
   * Resolve a copy to the files it replaces, the files it lists and what happens to the replaced
   * files' content, changing nothing
   * @throws {@link OcflError} `FILE_NOT_FOUND`, `FILE_EXISTS` or `INVALID_LOGICAL_PATH`
   * @internal
   */
  _planCopy(source: string, target: string, merge = false): RelistPlan {
    const { transfers, replaced } = this.#planTransfer(source, target, merge);
    return this.#relistPlan(transfers, replaced);
  }

  /**
   * Apply a plan from {@link _planCopy}, {@link _planRename} or {@link _planReinstate}, which must be
   * from the current head state
   * @internal
   */
  _applyRelist({ paths, files, releases }: RelistPlan): void {
    this._applyDelete({ paths, releases });
    for (const { logicalPath, digest, digests } of files) {
      this.#list(logicalPath, digest, digests);
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

  /**
   * Resolve a reinstate to the files it lists, the files they replace and what happens to the
   * replaced files' content, changing nothing
   * @param version - The number of a committed version
   * @throws {@link OcflError} `FILE_NOT_FOUND` if the version doesn't exist or has nothing at the path,
   * `FILE_EXISTS` if a file it lists is a directory or inside a file in the head state
   * @internal
   */
  _planReinstate(logicalPath: string, version: number): RelistPlan {
    const path = normaliseLogicalPath(logicalPath);
    const versionName = this.#committedVersionName(version);
    const found = versionName === undefined ? [] : this.#indexFindPaths(path, versionName);
    if (found.length === 0) {
      throw ocflError('FILE_NOT_FOUND', `Version ${version} of object [${this.id}] has nothing at logical path "${logicalPath}"`);
    }
    const files = found.flatMap((filePath) => {
      const digests = this.#indexGet(filePath, versionName);
      const digest = digests?.[this.digestAlgorithm];
      if (!digests || !digest || this.getDigest(filePath) === digest) {
        return [];
      }
      this._checkFilePath(filePath);
      return [{ logicalPath: filePath, digest, digests }];
    });
    const paths = files.map((file) => file.logicalPath).filter((filePath) => this.getDigest(filePath) !== undefined);
    return { files, paths, releases: this._contentReleases(paths) };
  }
}

export { isStagedRootInventory, isVersionName, OcflObjectInventory, rootInventoryPaths, sidecarContent, sidecarDigest, VersionNumber, validateStoredInventory };
