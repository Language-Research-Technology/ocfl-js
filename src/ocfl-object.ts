import fs from 'node:fs';
import nodePath from 'node:path';
import { OcflConstants, type OcflVersion } from './constants.ts';
import type { ContentAlgorithm } from './digest.ts';
import * as Hashing from './digest.ts';
import { checkedDetails, commitDraft, type Draft, type VersionDetails } from './draft.ts';
import { type OcflError, ocflError } from './error.ts';
import { type Inventory, isVersionName, OcflObjectInventory, sidecarDigest, VersionNumber, validateStoredInventory } from './inventory.ts';
import { isLocked, updateInProgress } from './lock.ts';
import { type OcflFile, StoredFile } from './ocfl-file.ts';
import type { StorageRoot } from './storage-root.ts';
import * as store from './store.ts';
import { assertNoMutableHead, objectWorkspace, updateTarget } from './transaction.ts';
import { dirContents, findNamasteVersion, hasErrorCode, isNotFound, isNothingAtPath, pathExists } from './utils.ts';
import { createError } from './validation.ts';

const { INVENTORY_NAME, NAMASTE_PREFIX_OBJECT } = OcflConstants;

const FIXITY_CONCURRENCY = 10;

/** The person or system responsible for a version. */
interface User {
  /** Display name. */
  readonly name: string;
  /** A URI for the user, such as `mailto:` or an ORCID. */
  readonly address?: string;
}

/** One version of an OCFL object. */
interface Version {
  /** Version number, starting at 1. */
  readonly number: number;
  /** When the version was committed. */
  readonly created: Date;
  /** Why the version was made. Absent if whatever wrote the version recorded none. */
  readonly message?: string;
  /** Who made the version. Absent if whatever wrote the version recorded none. */
  readonly user?: User;
  /** The version's files, keyed by logical path. */
  readonly files: ReadonlyMap<string, OcflFile>;
}

/** An OCFL object as read at one moment. */
interface OcflObject {
  /** The object's identifier. */
  readonly id: string;
  /** OCFL version the object conforms to. */
  readonly ocflVersion: '1.0' | '1.1';
  /** Algorithm of every {@link OcflFile.digest} in this object. */
  readonly digestAlgorithm: ContentAlgorithm;
  /** Every version, keyed by version number, oldest first. */
  readonly versions: ReadonlyMap<number, Version>;
  /** The latest version. */
  readonly head: Version;

  /**
   * Commits one new version made from the draft changed by `change`. If `change` throws, everything is discarded.
   * Returns the object with the new version, or this object if the draft ended the same as the head.
   * The update is committed when the root inventory is replaced: any error but `RECOVERY_NEEDED` means it wasn't committed and can be repeated.
   * This object never changes, whatever the outcome.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's declaration has been removed or damaged, or the object is now inside another object, since it was opened.
   * @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE` if the object has an active mutable head (extension 0005).
   * @throws {@link OcflError} `VERSION_LIMIT_REACHED` if the object's version names are zero-padded and the next one couldn't start with a zero, as OCFL requires (E011): `v01` to `v09` leaves none.
   * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if a later version has been committed since this object was opened; open it again and retry.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if another update of this object is running; `lockedAt` says since when, and is absent if the lock couldn't be read or was released meanwhile. The update never waits for it.
   * @throws {@link OcflError} `CROSS_FILESYSTEM_MOVE` if the workspace is on a different file system from the object.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if the update failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made couldn't all be removed; `cause` is the failure. The update may have been committed, and the object stays locked, so later updates throw `UPDATE_IN_PROGRESS`. Also thrown, before `change` runs and leaving the object unlocked, if an earlier update left an unfinished version in the workspace. Don't simply repeat the update: call {@link StorageRoot.recover}, then open the object again to see whether it was committed.
   * @throws `TypeError` if the message or the user's name is missing or empty.
   * @throws Whatever `change` or a draft operation throws; the update is discarded, and the object is as it was and isn't locked.
   * @example
   * ```ts
   * const updated = await object.update({ message: 'Fix transcript', user: { name: 'Alice' } }, async (draft) => {
   *   await draft.write('transcript.txt', corrected);
   * });
   * ```
   */
  update(details: VersionDetails, change: (draft: Draft) => Promise<void>): Promise<OcflObject>;

  /**
   * Reads every stored file again and compares its digest with the inventory. An empty list means the object is intact.
   * Covers the versions this object knows about. Does not look for extra files or check the `fixity` block.
   *
   * @throws The file system error, such as `EACCES` or `EIO`, if a stored file can't be read for any reason but being missing.
   */
  checkFixity(): Promise<readonly FixityProblem[]>;
}

/** One stored file that failed {@link OcflObject.checkFixity}. */
interface FixityProblem {
  /** `changed` if the content no longer matches its digest, `missing` if the stored file is gone. */
  readonly problem: 'changed' | 'missing';
  /** Where the stored file is, relative to the object, such as `v1/content/audio/1.wav`. */
  readonly contentPath: string;
  /** The digest the inventory records, in lowercase. */
  readonly expected: string;
  /** The digest found on disk, in lowercase. Absent when the file is missing. */
  readonly actual?: string;
}

class OpenedObject implements OcflObject {
  readonly id: string;
  readonly ocflVersion: OcflVersion;
  readonly digestAlgorithm: ContentAlgorithm;
  readonly versions: ReadonlyMap<number, Version>;
  readonly head: Version;
  readonly #inventory: OcflObjectInventory;
  readonly #root: string;
  readonly #storageRoot: string;

  /** @param inventory - As {@link readInventory} returns it, or as a commit returns it */
  constructor(storageRoot: string, root: string, ocflVersion: OcflVersion, inventory: OcflObjectInventory) {
    this.#storageRoot = storageRoot;
    this.#root = root;
    this.#inventory = inventory;
    this.id = inventory.id;
    this.ocflVersion = ocflVersion;
    this.digestAlgorithm = inventory.digestAlgorithm;
    this.versions = versionsOf(inventory, root);
    this.head = this.versions.get(inventory.versionNumber.value) as Version;
    Object.freeze(this);
  }

  /** @internal */
  get _inventory(): OcflObjectInventory {
    return this.#inventory;
  }

  /**
   * Absolute path of the object root
   * @internal
   */
  get _root(): string {
    return this.#root;
  }

  async update(details: VersionDetails, change: (draft: Draft) => Promise<void>): Promise<OcflObject> {
    const checked = checkedDetails(details);
    await declaredVersion(this.#storageRoot, this.#root);
    await assertNoMutableHead(
      this.#root,
      `The object <${this.id}> has an active mutable head (extension 0005), which this library doesn't support; it can't be updated until the head is committed or removed.`,
    );
    const inventory = OcflObjectInventory.newVersion(this.#inventory);
    const committed = await commitDraft(updateTarget(this.#storageRoot, this.#root, this.ocflVersion), inventory, checked, change);
    return committed ? new OpenedObject(this.#storageRoot, this.#root, this.ocflVersion, committed) : this;
  }

  async checkFixity(): Promise<readonly FixityProblem[]> {
    const storedFiles = storedFilesOf(this.#inventory);
    const problems: FixityProblem[] = [];
    // A worker that throws closes the shared iterator, which stops the others after the file each is reading
    const worker = async () => {
      for (const [contentPath, expected] of storedFiles) {
        const problem = await checkStoredFile(this.#root, contentPath, this.digestAlgorithm, expected);
        if (problem) {
          problems.push(problem);
        }
      }
    };
    // Settled, not raced, so no file is still being read when the check ends
    const outcomes = await Promise.allSettled(Array.from({ length: FIXITY_CONCURRENCY }, worker));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
    return problems.sort((a, b) => Number(a.contentPath > b.contentPath) - Number(a.contentPath < b.contentPath));
  }
}

/** Each stored file the inventory's manifest lists, with the normalised digest recorded for it */
function* storedFilesOf(inventory: OcflObjectInventory): Generator<[contentPath: string, digest: string]> {
  for (const [digest, contentPaths] of Object.entries(inventory.manifest)) {
    for (const contentPath of contentPaths) {
      yield [contentPath, Hashing.normaliseDigest(digest)];
    }
  }
}

/** The problem with the stored file at `contentPath` of the object at `objectRoot`, if it doesn't have the digest `expected` */
async function checkStoredFile(
  objectRoot: string,
  contentPath: string,
  digestAlgorithm: ContentAlgorithm,
  expected: string,
): Promise<FixityProblem | undefined> {
  let actual: string;
  try {
    actual = await Hashing.digest(digestAlgorithm, store.createReadable(nodePath.join(objectRoot, contentPath)));
  } catch (error) {
    if (isNotFound(error)) {
      return { problem: 'missing', contentPath, expected };
    }
    throw error;
  }
  return actual === expected ? undefined : { problem: 'changed', contentPath, expected, actual };
}

/** Each version's number and name, oldest first */
function versionNumbers(inventory: OcflObjectInventory): [number: number, name: string][] {
  return Object.keys(inventory.versions)
    .map((name): [number, string] => [VersionNumber.fromString(name).value, name])
    .sort(([a], [b]) => a - b);
}

class ObjectVersion implements Version {
  readonly number: number;
  readonly created: Date;
  declare readonly message?: string;
  declare readonly user?: User;
  readonly #inventory: OcflObjectInventory;
  readonly #name: string;
  readonly #objectRoot: string;
  #files: ReadonlyMap<string, OcflFile> | undefined;

  constructor(inventory: OcflObjectInventory, number: number, name: string, objectRoot: string) {
    const { created, message, user } = inventory.versions[name] as Inventory['versions'][string];
    this.number = number;
    this.created = new Date(created);
    if (typeof message === 'string') {
      this.message = message;
    }
    if (user) {
      this.user = Object.freeze({ name: user.name, ...(user.address !== undefined && { address: user.address }) });
    }
    this.#inventory = inventory;
    this.#name = name;
    this.#objectRoot = objectRoot;
    Object.freeze(this);
  }

  // Listed on first use: an object can have many versions of many files, and most readers want only the head
  get files(): ReadonlyMap<string, OcflFile> {
    if (!this.#files) {
      const files = new Map<string, OcflFile>();
      for (const { logicalPath, digest, contentPath } of this.#inventory.files(this.#name)) {
        files.set(logicalPath, new StoredFile(logicalPath, digest, this.#objectRoot, contentPath));
      }
      this.#files = files;
    }
    return this.#files;
  }
}

function versionsOf(inventory: OcflObjectInventory, objectRoot: string): ReadonlyMap<number, Version> {
  return new Map(versionNumbers(inventory).map(([number, name]) => [number, new ObjectVersion(inventory, number, name, objectRoot)]));
}

function invalidObject(message: string, options: { ocflCode?: string | undefined; cause?: unknown } = {}): OcflError {
  return ocflError('INVALID_OBJECT', message, options);
}

/** @throws {@link OcflError} `INVALID_OBJECT` if the versions of `inventory`, read from `file`, can't be listed */
function checkVersions(inventory: OcflObjectInventory, file: string): void {
  let previous: number | undefined;
  for (const [number, name] of versionNumbers(inventory)) {
    if (number === previous) {
      throw invalidObject(`The inventory ${file} has more than one version ${number}.`);
    }
    previous = number;
    const created = inventory.versions[name]?.created;
    if (typeof created !== 'string' || Number.isNaN(new Date(created).getTime())) {
      throw invalidObject(`The inventory ${file} has no valid created time for version ${name}.`, { ocflCode: 'E049' });
    }
  }
  if (inventory.versionNumber.value !== previous) {
    throw invalidObject(`The inventory ${file} has the head ${inventory.head}, which is not its latest version.`, { ocflCode: 'E040' });
  }
}

/** The file's text, or `undefined` if nothing can be at its path */
async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isNothingAtPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether the root inventory `text`, of digest `digest`, is the inventory of its head version `head`, as that version's own sidecar confirms.
 * A commit replaces the root inventory and then its sidecar, so between the two the root inventory is right and its sidecar is not.
 */
async function isHeadVersionInventory(objectRoot: string, head: unknown, text: string, digestAlgorithm: ContentAlgorithm, digest: string): Promise<boolean> {
  // Not yet validated, so it could name anything
  if (typeof head !== 'string' || !isVersionName(head)) {
    return false;
  }
  const file = nodePath.join(objectRoot, head, INVENTORY_NAME);
  const [inventory, sidecar] = await Promise.all([readIfPresent(file), readIfPresent(`${file}.${digestAlgorithm}`)]);
  return inventory === text && sidecarDigest(sidecar) === digest;
}

/**
 * Reads the root inventory of the object at `objectRoot` and checks it against its sidecar, or against its head version while a commit is replacing the sidecar.
 * @returns `undefined` if there is no inventory
 * @throws {@link OcflError} `INVALID_OBJECT` if the inventory or its sidecar is missing, corrupt or inconsistent
 */
async function readInventory(objectRoot: string): Promise<OcflObjectInventory | undefined> {
  const file = nodePath.join(objectRoot, INVENTORY_NAME);
  const text = await readIfPresent(file);
  if (text === undefined) {
    return undefined;
  }
  let data: Inventory;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw invalidObject(`The inventory ${file} is not valid JSON.`, { ocflCode: 'E033', cause });
  }
  const digestAlgorithm: unknown = data?.digestAlgorithm;
  if (digestAlgorithm !== 'sha256' && digestAlgorithm !== 'sha512') {
    throw invalidObject(`The inventory ${file} has a digestAlgorithm that is not sha256 or sha512.`, { ocflCode: 'E025' });
  }
  const sidecar = await readIfPresent(`${file}.${digestAlgorithm}`);
  const recorded = sidecarDigest(sidecar);
  const actual = await Hashing.digest(digestAlgorithm, text);
  let inventory: OcflObjectInventory;
  try {
    if (recorded !== actual && !(await isHeadVersionInventory(objectRoot, data.head, text, digestAlgorithm, actual))) {
      throw sidecar === undefined
        ? createError('E058', file, `no ${digestAlgorithm} sidecar`)
        : createError('E060', file, `recorded=${recorded} actual=${actual}`);
    }
    validateStoredInventory(data, file);
    if (typeof data.head !== 'string') {
      throw createError('E040', file, 'head is not a string');
    }
    if (typeof data.id !== 'string') {
      throw createError('E036', file, 'missing id');
    }
    inventory = new OcflObjectInventory(data);
  } catch (cause) {
    // The inventory isn't shaped as the checks assume
    if (cause instanceof TypeError) {
      throw invalidObject(`The inventory ${file} is malformed.`, { ocflCode: 'E033', cause });
    }
    throw cause;
  }
  checkVersions(inventory, file);
  inventory._digest = actual;
  return inventory;
}

/** For an `objectRoot` that the layout gives to the object `id`, and that holds the object `found` */
function holdsAnotherObject(objectRoot: string, found: string, id: string): OcflError {
  return ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot} holds the object <${found}>, not <${id}>.`);
}

/** The nearest directory between the storage root and `objectRoot` that is itself an object, if any */
async function enclosingObject(storageRoot: string, objectRoot: string): Promise<string | undefined> {
  const ancestors: string[] = [];
  for (let dir = nodePath.dirname(objectRoot); dir.startsWith(storageRoot + nodePath.sep); dir = nodePath.dirname(dir)) {
    ancestors.push(dir);
  }
  const declared = await Promise.all(ancestors.map((dir) => findNamasteVersion(NAMASTE_PREFIX_OBJECT, dir)));
  return ancestors.find((_dir, i) => declared[i]);
}

/** Whether `dir` has an object declaration file, whatever it holds */
async function hasObjectDeclaration(dir: string): Promise<boolean> {
  try {
    return (await findNamasteVersion(NAMASTE_PREFIX_OBJECT, dir)) !== undefined;
  } catch (error) {
    if (hasErrorCode(error, 'ENAMETOOLONG')) {
      return false;
    }
    throw error;
  }
}

/**
 * The OCFL version declared by the object at `objectRoot`, which has an inventory.
 * @throws {@link OcflError} `INVALID_OBJECT` if its declaration is missing or wrong, or it is inside another object
 */
async function declaredVersion(storageRoot: string, objectRoot: string): Promise<OcflVersion> {
  const [ocflVersion, outer] = await Promise.all([findNamasteVersion(NAMASTE_PREFIX_OBJECT, objectRoot), enclosingObject(storageRoot, objectRoot)]);
  if (ocflVersion === '') {
    throw createError('E007', objectRoot);
  }
  if (!ocflVersion) {
    throw invalidObject(`${objectRoot} has an inventory but no OCFL object declaration.`, { ocflCode: 'E003' });
  }
  if (outer !== undefined) {
    throw nestedObject(objectRoot, outer);
  }
  return ocflVersion;
}

/**
 * The OCFL version declared by the object at `objectRoot`, whose root inventory is `inventory`, once it is known to be the object `id`.
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link declaredVersion} does
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if it is an object with another id
 */
async function confirmedVersion(storageRoot: string, objectRoot: string, inventory: OcflObjectInventory, id: string): Promise<OcflVersion> {
  const ocflVersion = await declaredVersion(storageRoot, objectRoot);
  if (inventory.id !== id) {
    throw holdsAnotherObject(objectRoot, inventory.id, id);
  }
  return ocflVersion;
}

/** For an object at `objectRoot`, which is inside the object at `outer` */
function nestedObject(objectRoot: string, outer: string): OcflError {
  return createError('E082', objectRoot, `nested under the object at ${outer}`);
}

/** For an `objectRoot` that the layout gives to the object `id`, and that is inside the object at `outer` */
function insideAnotherObject(objectRoot: string, id: string, outer: string): OcflError {
  return ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot}, where the storage root places <${id}>, is inside the object at ${outer}.`);
}

function objectNotFound(storageRoot: string, id: string): OcflError {
  return ocflError('OBJECT_NOT_FOUND', `There is no object <${id}> in the storage root ${storageRoot}.`);
}

/** For an `objectRoot` with an object declaration and no inventory, which no writer is working on */
function declarationWithoutInventory(objectRoot: string): OcflError {
  return invalidObject(`${objectRoot} has an OCFL object declaration but no inventory.`, { ocflCode: 'E063' });
}

/**
 * Opens the object `id` that the storage root's layout places at `objectRoot`.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if `objectRoot` has no inventory, and either no object declaration or a lock held: a create that isn't committed
 * @throws {@link OcflError} `INVALID_OBJECT` if it has only one of them and isn't locked, is inside another object, or its inventory can't be used
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if it holds an object with another id
 */
async function openObject(storageRoot: string, objectRoot: string, id: string): Promise<OcflObject> {
  const inventory = await committedInventory(storageRoot, objectRoot);
  if (!inventory) {
    throw objectNotFound(storageRoot, id);
  }
  return new OpenedObject(storageRoot, objectRoot, await confirmedVersion(storageRoot, objectRoot, inventory, id), inventory);
}

/**
 * Opens the object at `objectRoot`, a directory found with the object declaration `declared` and inside no other object.
 * @param declared - As `findNamasteVersion` returns it for a declaration that exists
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has gone
 * @throws {@link OcflError} `INVALID_OBJECT` if its declaration is invalid, or its inventory is missing or can't be used
 */
async function openDeclaredObject(storageRoot: string, objectRoot: string, declared: OcflVersion | ''): Promise<OcflObject | undefined> {
  if (declared === '') {
    throw createError('E007', objectRoot);
  }
  const inventory = await committedInventory(storageRoot, objectRoot);
  return inventory && new OpenedObject(storageRoot, objectRoot, declared, inventory);
}

/**
 * The root inventory of the object at `objectRoot`.
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has neither an inventory nor an object declaration
 * @throws {@link OcflError} `INVALID_OBJECT` with E063 if it has a declaration, no inventory and no lock held
 */
async function committedInventory(storageRoot: string, objectRoot: string): Promise<OcflObjectInventory | undefined> {
  const inventory = await readInventory(objectRoot);
  if (inventory || !(await hasObjectDeclaration(objectRoot)) || (await isLocked(objectWorkspace(storageRoot, objectRoot)))) {
    return inventory;
  }
  // Its writer may have finished between the two: a create by committing, a remove by deleting it
  const reread = await readInventory(objectRoot);
  if (!reread && (await hasObjectDeclaration(objectRoot))) {
    throw declarationWithoutInventory(objectRoot);
  }
  return reread;
}

/**
 * Creates the object `id` at `objectRoot`, where the storage root's layout places it, with the draft `build` leaves as its first version.
 * @param details - As {@link checkedDetails} returns them
 * @throws {@link OcflError} `OBJECT_EXISTS` if `objectRoot` has an object declaration or an inventory
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if it has a declaration, no inventory and a lock held: a create that isn't committed
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if it holds anything else, or is inside another object
 */
async function createObject(
  storageRoot: string,
  objectRoot: string,
  id: string,
  ocflVersion: OcflVersion,
  details: VersionDetails,
  build: (draft: Draft) => Promise<void>,
): Promise<OcflObject> {
  const declared = await hasObjectDeclaration(objectRoot);
  const hasInventory = await pathExists(nodePath.join(objectRoot, INVENTORY_NAME));
  if (declared || hasInventory) {
    const workspace = objectWorkspace(storageRoot, objectRoot);
    if (!hasInventory && (await isLocked(workspace))) {
      throw await updateInProgress(workspace);
    }
    throw ocflError('OBJECT_EXISTS', `There is already an object at ${objectRoot}, where the storage root ${storageRoot} places <${id}>.`);
  }
  const contents = await dirContents(objectRoot);
  if (contents === 'not empty') {
    throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot}, where the storage root places <${id}>, is not empty.`);
  }
  if (contents === 'below a file') {
    throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot}, where the storage root places <${id}>, is below a file.`);
  }
  const outer = await enclosingObject(storageRoot, objectRoot);
  if (outer !== undefined) {
    throw insideAnotherObject(objectRoot, id, outer);
  }
  const inventory = OcflObjectInventory.newVersion({
    id,
    digestAlgorithm: 'sha512',
    type: `https://ocfl.io/${ocflVersion}/spec/#inventory`,
    contentDirectory: 'content',
  });
  const committed = await commitDraft(updateTarget(storageRoot, objectRoot, ocflVersion), inventory, details, build);
  if (!committed) {
    throw new Error(`No first version of <${id}> was committed.`);
  }
  return new OpenedObject(storageRoot, objectRoot, ocflVersion, committed);
}

export {
  confirmedVersion,
  createObject,
  declarationWithoutInventory,
  enclosingObject,
  type FixityProblem,
  hasObjectDeclaration,
  holdsAnotherObject,
  insideAnotherObject,
  nestedObject,
  type OcflObject,
  objectNotFound,
  openDeclaredObject,
  openObject,
  readInventory,
  type User,
  type Version,
};
