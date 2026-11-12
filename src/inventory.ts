import nodePath from 'node:path';
import { OcflConstants, type OcflVersion } from './constants.ts';
import { type ContentAlgorithm, normaliseDigest } from './digest.ts';
import { ocflError } from './error.ts';
import { normaliseLogicalPath, parentDirectories } from './utils.ts';
import { createError } from './validation.ts';

const { INVENTORY_NAME } = OcflConstants;

/** `T` and everything nested in it, read-only at compile time. The data isn't frozen. */
type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

interface InventoryDigests {
  [key: string]: string[];
}

interface InventoryVersion {
  created: string;
  message?: string;
  state: InventoryDigests;
  user?: {
    name: string;
    address?: string;
  };
}

interface Inventory {
  /** A unique identifier for the OCFL Object. */
  id: string;
  /** The URI of the inventory section of the specification version matching the object conformance declaration. */
  type: `https://ocfl.io/${OcflVersion}/spec/#inventory`;
  /**
   * The algorithm used for calculating digests for content-addressing
   * within the OCFL Object and for the Inventory Digest.
   * This MUST be the algorithm used in the manifest and state blocks
   */
  digestAlgorithm: ContentAlgorithm;
  /** The version directory name of the most recent version of the object. */
  head: string;
  manifest: InventoryDigests;
  versions: {
    [key: string]: InventoryVersion;
  };
  fixity?: {
    [key: string]: {
      [key: string]: string[];
    };
  };
  /**
   * The name of the designated content directory within the version directories.
   * @defaultValue content
   */
  contentDirectory?: string;
}

interface InventoryFile {
  logicalPath: string;
  digest: string;
  contentPath: string;
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

/** The digest an inventory sidecar records, normalised, if it records one */
function sidecarDigest(sidecar: string | undefined): string | undefined {
  const recorded = sidecar?.match(/\S+/)?.[0];
  return recorded === undefined ? undefined : normaliseDigest(recorded);
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `block` maps each digest to an array of content paths, as a manifest does */
function isDigestBlock(block: unknown): boolean {
  return isJsonObject(block) && Object.values(block).every((paths) => Array.isArray(paths) && paths.every((path) => typeof path === 'string'));
}

/**
 * Checks an inventory read from storage, before its values are used as paths in the object root.
 * The constructor checks that `head` is one of the versions.
 * @param file - The inventory's path, for the error
 * @throws {@link OcflError} `INVALID_OBJECT` with `E036` or `E040` for a missing or empty head, `E104` for a version name,
 * `E017` or `E018` for the contentDirectory, `E099` or `E100` for a content path, or `E111` or `E057` for the fixity block
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
  const fixity: unknown = data.fixity;
  if (fixity !== undefined && fixity !== null) {
    if (!isJsonObject(fixity)) {
      throw createError('E111', file, 'fixity is not an object');
    }
    const malformed = Object.keys(fixity).find((algorithm) => !isDigestBlock(fixity[algorithm]));
    if (malformed !== undefined) {
      throw createError('E057', file, `fixity "${malformed}"`);
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
  files: { logicalPath: string; digest: string }[];
}

/**
 * An OCFL object's inventory. Only a transaction changes it, while it builds a new version.
 */
class OcflObjectInventory {
  #data: Inventory;
  /** The manifest's key for each digest, by its normalised form */
  #manifestKeys = new Map<string, string>();
  /** The normalised digest of each file of each version, by version name then logical path */
  #fileIndex = new Map<string, Map<string, string>>();
  /** How many files each directory of the head state contains, at any depth */
  #headDirectories = new Map<string, number>();

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

  /** The index of a version, made if it has none yet */
  #versionIndex(version: string): Map<string, string> {
    let index = this.#fileIndex.get(version);
    if (!index) {
      index = new Map();
      this.#fileIndex.set(version, index);
    }
    return index;
  }

  /** @param digest - Normalised */
  #indexAdd(logicalPath: string, version: string, digest: string) {
    const index = this.#versionIndex(version);
    if (version === this.head && !index.has(logicalPath)) {
      this.#adjustDirectoryCounts(logicalPath, 1);
    }
    index.set(logicalPath, digest);
  }

  #indexRemove(logicalPath: string) {
    if (this.#fileIndex.get(this.head)?.delete(logicalPath)) {
      this.#adjustDirectoryCounts(logicalPath, -1);
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

  /** @throws {@link OcflError} `INVALID_OBJECT` with `E050` if a version's state has a digest the manifest doesn't */
  #checkStatesInManifest() {
    for (const { state } of Object.values(this.versions)) {
      for (const digest of Object.keys(state)) {
        this.#requireContentPaths(digest);
      }
    }
  }

  #indexBuild() {
    for (const [verName, ver] of Object.entries(this.versions)) {
      this.#versionIndex(verName);
      for (const [digest, lps] of Object.entries(ver.state)) {
        const normalised = normaliseDigest(digest);
        for (const lp of lps) {
          this.#indexAdd(lp, verName, normalised);
        }
      }
    }
  }

  #indexFindPaths(prefix: string, versionName = this.head) {
    const prefixWithSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return [...this.#versionIndex(versionName).keys()].filter((lp) => lp === prefix || lp.startsWith(prefixWithSlash));
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
    for (const digest of Object.keys(data.manifest)) {
      const normalised = normaliseDigest(digest);
      if (this.#manifestKeys.has(normalised)) {
        throw createError('E096', data.id, `digest "${digest}" is in the manifest more than once`);
      }
      this.#manifestKeys.set(normalised, digest);
    }
    this.#checkStatesInManifest();
    this.#indexBuild();
  }

  get id(): string {
    return this.#data.id;
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
  /** The state of the head version. Throws if the head is not in versions. */
  get state(): DeepReadonly<InventoryDigests> {
    return headVersion(this.#data).state;
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

  /** The files of a version, which has none if it doesn't exist */
  *files(versionName: string): Generator<InventoryFile> {
    for (const [digest, files] of Object.entries(this.versions[versionName]?.state ?? {})) {
      const [contentPath] = this.#requireContentPaths(digest);
      const normalised = normaliseDigest(digest);
      for (const logicalPath of files) {
        yield { logicalPath, digest: normalised, contentPath };
      }
    }
  }

  /** The first content path the manifest lists for a digest, or `undefined` if it lists none */
  getContentPath(digest: string): string | undefined {
    return this.#contentPaths(digest)?.[0];
  }

  /** The manifest's key for `digest`, in whatever case the manifest spells it */
  #manifestKey(digest: string): string | undefined {
    return this.#manifestKeys.get(normaliseDigest(digest));
  }

  /** @throws {@link OcflError} `INVALID_OBJECT` with `E050` if the manifest doesn't have `digest` */
  #requireManifestKey(digest: string): string {
    const key = this.#manifestKey(digest);
    if (key === undefined) {
      throw createError('E050', this.id, `digest "${digest}" is not in the manifest`);
    }
    return key;
  }

  /** Set the content paths of a digest, under the manifest's spelling of it if it has one */
  #setManifestEntry(digest: string, contentPaths: string[]) {
    const key = this.#manifestKey(digest) ?? digest;
    this.#data.manifest[key] = contentPaths;
    this.#manifestKeys.set(normaliseDigest(key), key);
  }

  #deleteManifestEntry(digest: string) {
    delete this.#data.manifest[this.#requireManifestKey(digest)];
    this.#manifestKeys.delete(normaliseDigest(digest));
  }

  #contentPaths(digest: string): DeepReadonly<string[]> | undefined {
    const key = this.#manifestKey(digest);
    return key === undefined ? undefined : this.manifest[key];
  }

  #requireContentPaths(digest: string): readonly [string, ...string[]] {
    const cps = this.manifest[this.#requireManifestKey(digest)];
    if (!isNonEmpty(cps)) {
      throw createError('E050', this.id, `digest "${digest}" has no content paths in the manifest`);
    }
    return cps;
  }

  /**
   * The logical paths of the head state with the content of `digest`
   * @internal
   */
  _headFiles(digest: string): readonly string[] {
    return this.#headStateEntry(digest).files;
  }

  /** The normalised digest of the file at a logical path in a version, the head by default */
  getDigest(logicalPath: string, versionName: string = this.head): string | undefined {
    return this.#fileIndex.get(versionName)?.get(logicalPath);
  }

  /**
   * Create an inventory for a new version, from the object config or a copy of an existing inventory.
   * If data.head is undefined, starts from v1.
   * @internal
   */
  static newVersion(data: Partial<Inventory> | OcflObjectInventory): OcflObjectInventory {
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
      const prev = data.versions[data.head];
      if (!prev) {
        throw headNotInVersionsError(data.id, data.head);
      }
      state = JSON.parse(JSON.stringify(prev.state));
      data.head = VersionNumber._among(data.head, Object.keys(data.versions)).next().toString();
    } else {
      data.head = 'v1';
    }
    data.versions[data.head] = {
      created: new Date().toISOString(),
      state,
    };
    const next = new OcflObjectInventory(data as Inventory);
    next.#rekeyHeadStateToManifest();
    next._madeFrom = madeFrom;
    return next;
  }

  /** Rekey the head state with the manifest's spelling of each digest, so the version writes keys that match it exactly */
  #rekeyHeadStateToManifest() {
    const version = headVersion(this.#data);
    const entries = Object.entries(version.state);
    if (entries.every(([digest]) => this.#requireManifestKey(digest) === digest)) {
      return;
    }
    const state: InventoryDigests = {};
    for (const [digest, files] of entries) {
      const key = this.#requireManifestKey(digest);
      state[key] = [...(state[key] ?? []), ...files];
    }
    version.state = state;
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
    const head = this.#versionIndex(this.head);
    const previous = this.#versionIndex(prev);
    if (head.size !== previous.size) {
      return true;
    }
    for (const [logicalPath, digest] of head) {
      if (previous.get(logicalPath) !== digest) {
        return true;
      }
    }
    return false;
  }

  /** The head state entry for a digest the manifest has, and its key */
  #headStateEntry(digest: string): { key: string; files: string[] } {
    const key = this.#requireManifestKey(digest);
    return { key, files: headVersion(this.#data).state[key] ?? [] };
  }

  /**
   * Remove exactly one logical path from its digest's list in the head version state
   * @returns true if the path was listed
   */
  #unlist(logicalPath: string): boolean {
    const digest = this.getDigest(logicalPath);
    const entry = digest === undefined ? undefined : this.#headStateEntry(digest);
    const index = entry?.files.indexOf(logicalPath) ?? -1;
    if (!entry || index < 0) {
      return false;
    }
    if (entry.files.length === 1) {
      delete headVersion(this.#data).state[entry.key];
    } else {
      entry.files.splice(index, 1);
    }
    this.#indexRemove(logicalPath);
    return true;
  }

  /** Append a logical path to its digest's list in the head version state, for a normalised digest the manifest has */
  #list(logicalPath: string, digest: string) {
    const { state } = headVersion(this.#data);
    const key = this.#requireManifestKey(digest);
    state[key] ??= [];
    state[key].push(logicalPath);
    this.#indexAdd(logicalPath, this.head, digest);
  }

  /**
   * Add a new file to the inventory or update the digest of an existing file
   * @returns true if the state is changed
   * @throws {@link OcflError} `FILE_EXISTS` if the path is a directory, or is inside a file
   * @internal
   */
  _add(logicalPath: string, rawDigest: string): boolean {
    const digest = normaliseDigest(rawDigest);
    this._checkFilePath(logicalPath);
    if (this.getDigest(logicalPath) !== digest) {
      const releases = this._contentReleases([logicalPath]);
      this.#unlist(logicalPath);
      this.#applyContentReleases(releases);
    }
    if (!this.getContentPath(digest)) {
      this.#setManifestEntry(digest, [this.#ownContentPath(logicalPath)]);
    }
    if (this.getDigest(logicalPath) === digest) {
      return false;
    }
    this.#list(logicalPath, digest);
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
      const heirs = [...(follows ? [follows.dest] : []), ...this._headFiles(digest).filter((file) => !leaving.has(file)), ...arrivals.map(({ dest }) => dest)];
      const [heir] = heirs;
      if (heir === undefined) {
        return [{ digest, from }];
      }
      const stays = !ownPaths.has(from) || heirs.some((file) => this.#ownContentPath(file) === from);
      return stays ? [] : [{ digest, from, to: this.#ownContentPath(heir) }];
    });
  }

  #applyContentReleases(releases: ContentRelease[]) {
    for (const { digest, to } of releases) {
      if (to === undefined) {
        this.#deleteManifestEntry(digest);
      } else {
        this.#setManifestEntry(digest, [to]);
      }
    }
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
      const digest = this.getDigest(file);
      return digest ? [{ src: file, dest: `${dest}${file.slice(src.length)}`, digest }] : [];
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
      .map(({ dest, digest }) => ({ logicalPath: dest, digest }));
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
    for (const { logicalPath, digest } of files) {
      this.#list(logicalPath, digest);
    }
  }

  /**
   * Resolve the delete of a file or directory to the paths it unlists and what happens to their content, changing
   * nothing. Content the head version stored moves to a remaining logical path that uses it, or leaves the manifest if none does.
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
      const digest = this.getDigest(filePath, versionName);
      if (!digest || this.getDigest(filePath) === digest) {
        return [];
      }
      this._checkFilePath(filePath);
      return [{ logicalPath: filePath, digest }];
    });
    const paths = files.map((file) => file.logicalPath).filter((filePath) => this.getDigest(filePath) !== undefined);
    return { files, paths, releases: this._contentReleases(paths) };
  }
}

export {
  type Inventory,
  isStagedRootInventory,
  isVersionName,
  OcflObjectInventory,
  rootInventoryPaths,
  sidecarContent,
  sidecarDigest,
  VersionNumber,
  validateStoredInventory,
};
