import fs from 'node:fs';
import nodePath from 'node:path';
import { type DeclarationsFound, findNamasteVersion, OcflConstants, type OcflVersion, SEVERAL_DECLARATIONS } from './constants.ts';
import type { DigestAlgorithm } from './digest.ts';
import * as Hashing from './digest.ts';
import { type OcflError, objectRootConflict, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { type Inventory, OcflObjectInventory, validateStoredInventory, versionNumbers } from './inventory.ts';
import { isVersionName, sidecarDigest, VersionNumber } from './inventory-files.ts';
import { isLocked } from './lock.ts';
import { createError } from './ocfl-rules.ts';
import { isJsonObject, parseJsonObject } from './utils.ts';
import { objectWorkspace } from './workspace.ts';

const { EXTENSIONS_DIR, INVENTORY_NAME, NAMASTE_PREFIX_OBJECT } = OcflConstants;
const MUTABLE_HEAD_INVENTORY = nodePath.join(EXTENSIONS_DIR, '0005-mutable-head', 'head', INVENTORY_NAME);

/** @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE`, with `message`, if the object has an active mutable head (extension 0005) */
async function assertNoMutableHead(objectRoot: string, message: string): Promise<void> {
  if (await fileSystem.pathExists(nodePath.join(objectRoot, MUTABLE_HEAD_INVENTORY))) {
    throw ocflError('MUTABLE_HEAD_ACTIVE', message);
  }
}

function invalidObject(message: string, options: { ocflCode?: string | undefined; cause?: unknown } = {}): OcflError {
  return ocflError('INVALID_OBJECT', message, options);
}

/**
 * @throws {@link OcflError} `INVALID_OBJECT` if the versions of `inventory`, read from `file`, can't be listed: with `E011` or `E012` for
 * names that mix zero-padding conventions, `E009` or `E010` for numbers that don't run 1, 2, 3…, `E049` for a version with no valid created
 * time, or `E040` for a head that isn't the latest version
 */
function checkVersions(inventory: OcflObjectInventory, file: string): void {
  const widths = new Map(Object.keys(inventory.versions).map((name) => [VersionNumber._fromString(name).zeroPaddingLength, name]));
  if (widths.size > 1) {
    const unpadded = widths.get(undefined);
    throw unpadded === undefined
      ? createError('E012', file, `zero-padded versions of different widths: ${[...widths.values()].sort().join(', ')}`)
      : createError('E011', file, `${unpadded} among zero-padded versions`);
  }
  let previous = 0;
  for (const [number, name] of versionNumbers(inventory)) {
    if (number !== previous + 1) {
      throw previous === 0 ? createError('E009', file, `the first version is ${name}`) : createError('E010', file, `no version ${previous + 1}`);
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

/**
 * Whether the root inventory `text`, of digest `digest`, is the inventory of its head version `head`, as that version's own sidecar confirms.
 * A commit replaces the root inventory and then its sidecar, so between the two the root inventory is right and its sidecar is not.
 */
async function isHeadVersionInventory(objectRoot: string, head: unknown, text: string, digestAlgorithm: DigestAlgorithm, digest: string): Promise<boolean> {
  // Not yet validated, so it could name anything
  if (typeof head !== 'string' || !isVersionName(head)) {
    return false;
  }
  const file = nodePath.join(objectRoot, head, INVENTORY_NAME);
  const [inventory, sidecar] = await Promise.all([fileSystem.readIfPresent(file), fileSystem.readIfPresent(`${file}.${digestAlgorithm}`)]);
  return inventory === text && sidecarDigest(sidecar) === digest;
}

/**
 * The id the root inventory of the object at `objectRoot` names, unchecked, for an object that can't be opened.
 * @returns `undefined` if the inventory can't be read, isn't JSON, or its `id` isn't a string
 */
async function idInRootInventory(objectRoot: string): Promise<string | undefined> {
  const text = await fs.promises.readFile(nodePath.join(objectRoot, INVENTORY_NAME), 'utf8').catch(() => undefined);
  const id = text === undefined ? undefined : parseJsonObject(text)?.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Reads the root inventory of the object at `objectRoot`, in the storage root at `storageRoot`, and checks it against its sidecar.
 * While another writer holds the object's lock, a commit may be replacing the sidecar, so the inventory of its head version is accepted instead.
 * @param options.callerHoldsLock - Whether the caller holds the lock, so no other writer can be committing
 * @returns `undefined` if there is no inventory
 * @throws {@link OcflError} `INVALID_OBJECT` if the inventory or its sidecar is missing, corrupt or inconsistent, its id is missing or
 * empty (`E036`), or its versions break a rule {@link checkVersions} checks
 */
function readInventory(storageRoot: string, objectRoot: string, options: { callerHoldsLock?: boolean } = {}): Promise<OcflObjectInventory | undefined> {
  return readInventoryAttempt(storageRoot, objectRoot, options.callerHoldsLock ? 'own lock' : 'first read');
}

/** `E058` or `E060` for the root inventory `file`, of digest `actual`, whose sidecar `sidecar` records `recorded` */
function sidecarRefusal(file: string, digestAlgorithm: DigestAlgorithm, sidecar: string | undefined, recorded: string | undefined, actual: string): OcflError {
  return sidecar === undefined
    ? createError('E058', file, `no ${digestAlgorithm} sidecar`)
    : createError('E060', file, `recorded=${recorded} actual=${actual}`);
}

/**
 * {@link readInventory}. On a `'first read'` with no lock held, a sidecar that only a commit explains is read once more, as its
 * writer may have replaced the sidecar and released the lock since the sidecar was read.
 */
async function readInventoryAttempt(
  storageRoot: string,
  objectRoot: string,
  attempt: 'first read' | 'second read' | 'own lock',
): Promise<OcflObjectInventory | undefined> {
  const file = nodePath.join(objectRoot, INVENTORY_NAME);
  const read = await fileSystem.readWithIdentity(file);
  if (read === undefined) {
    return undefined;
  }
  const { text, identity } = read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw invalidObject(`The inventory ${file} is not valid JSON.`, { ocflCode: 'E033', cause });
  }
  if (!isJsonObject(parsed)) {
    throw invalidObject(`The inventory ${file} is not a JSON object.`, { ocflCode: 'E033' });
  }
  const data = parsed as unknown as Inventory;
  const digestAlgorithm: unknown = data.digestAlgorithm;
  if (digestAlgorithm !== 'sha256' && digestAlgorithm !== 'sha512') {
    throw invalidObject(`The inventory ${file} has a digestAlgorithm that is not sha256 or sha512.`, { ocflCode: 'E025' });
  }
  const sidecar = await fileSystem.readIfPresent(`${file}.${digestAlgorithm}`);
  const recorded = sidecarDigest(sidecar);
  const actual = await Hashing.digest(digestAlgorithm, text);
  let inventory: OcflObjectInventory;
  try {
    if (recorded !== actual) {
      const committing = attempt !== 'own lock' && (await isLocked(objectWorkspace(storageRoot, objectRoot)));
      const mayRetry = attempt === 'first read' && !committing;
      if (!(committing || mayRetry) || !(await isHeadVersionInventory(objectRoot, data.head, text, digestAlgorithm, actual))) {
        throw sidecarRefusal(file, digestAlgorithm, sidecar, recorded, actual);
      }
      if (mayRetry) {
        return readInventoryAttempt(storageRoot, objectRoot, 'second read');
      }
    }
    validateStoredInventory(data, file);
    if (typeof data.head !== 'string') {
      throw createError('E040', file, 'head is not a string');
    }
    if (typeof data.id !== 'string') {
      throw createError('E036', file, 'missing id');
    }
    if (data.id === '') {
      throw createError('E036', file, 'empty id');
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
  inventory._identity = identity;
  return inventory;
}

/** For an `objectRoot` that the storage layout gives to the object `id`, and that holds the object `found` */
function holdsAnotherObject(objectRoot: string, found: string, id: string): OcflError {
  return objectRootConflict(objectRoot, id, `holds the object <${found}>`);
}

/**
 * The OCFL version the declaration `declared`, found in `objectRoot`, gives
 * @throws {@link OcflError} `INVALID_OBJECT` with `E003` for more than one declaration, or `E007` for one with the wrong contents
 */
function checkedDeclaration(objectRoot: string, declared: DeclarationsFound): OcflVersion {
  if (declared === SEVERAL_DECLARATIONS) {
    throw createError('E003', objectRoot, 'it has more than one object declaration');
  }
  if (declared === '') {
    throw createError('E007', objectRoot);
  }
  return declared;
}

/**
 * The OCFL version the object declaration in `objectRoot` gives, or `undefined` if it has none
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link checkedDeclaration} does
 */
async function objectDeclaration(objectRoot: string): Promise<OcflVersion | undefined> {
  const declared = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, objectRoot);
  return declared === undefined ? undefined : checkedDeclaration(objectRoot, declared);
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
  return (await findNamasteVersion(NAMASTE_PREFIX_OBJECT, dir)) !== undefined;
}

/**
 * What a create finds at `objectRoot`, unread and unchecked: a committed object, which has a root inventory or an object declaration with no lock held;
 * a create that holds its lock and hasn't committed; or neither
 */
async function objectState(storageRoot: string, objectRoot: string): Promise<'committed' | 'creating' | 'none'> {
  const [hasInventory, declared] = await Promise.all([fileSystem.pathExists(nodePath.join(objectRoot, INVENTORY_NAME)), hasObjectDeclaration(objectRoot)]);
  if (hasInventory) {
    return 'committed';
  }
  if (!declared) {
    return 'none';
  }
  return (await isLocked(objectWorkspace(storageRoot, objectRoot))) ? 'creating' : 'committed';
}

/**
 * The OCFL version declared by the object at `objectRoot`, which has an inventory.
 * @throws {@link OcflError} `INVALID_OBJECT` if its declaration is missing (`E003`) or wrong as {@link checkedDeclaration} finds it, or it is inside another object
 */
async function declaredVersion(storageRoot: string, objectRoot: string): Promise<OcflVersion> {
  const [ocflVersion, outer] = await Promise.all([objectDeclaration(objectRoot), enclosingObject(storageRoot, objectRoot)]);
  if (!ocflVersion) {
    throw createError('E003', objectRoot, 'it has an inventory but no object declaration');
  }
  if (outer !== undefined) {
    throw nestedObject(objectRoot, outer);
  }
  return ocflVersion;
}

/**
 * The OCFL version declared by the object at `objectRoot`, whose root inventory is `inventory`, once it is known to be the object `id`.
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link declaredVersion} does
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it is an object with another id
 */
async function confirmedVersion(storageRoot: string, objectRoot: string, inventory: OcflObjectInventory, id: string): Promise<OcflVersion> {
  const ocflVersion = await declaredVersion(storageRoot, objectRoot);
  if (inventory.id !== id) {
    throw holdsAnotherObject(objectRoot, inventory.id, id);
  }
  return ocflVersion;
}

/**
 * `ocflVersion`, declared by the object at `objectRoot`, once it is known to be no later than `rootVersion`, its storage root's.
 * @throws {@link OcflError} `INVALID_OBJECT` with E081 if it is later
 */
function withinRootVersion(objectRoot: string, ocflVersion: OcflVersion, rootVersion: OcflVersion): OcflVersion {
  if (ocflVersion > rootVersion) {
    throw createError('E081', objectRoot, `an OCFL ${ocflVersion} object in an OCFL ${rootVersion} storage root`);
  }
  return ocflVersion;
}

/** For an object at `objectRoot`, which is inside the object at `outer` */
function nestedObject(objectRoot: string, outer: string): OcflError {
  return createError('E082', objectRoot, `nested under the object at ${outer}`);
}

/** @param unplaceable - The layout's refusal of `id`, if that is why there is no object */
function objectNotFound(storageRoot: string, id: string, unplaceable?: OcflError): OcflError {
  const message = `There is no object <${id}> in the storage root ${storageRoot}`;
  return unplaceable === undefined
    ? ocflError('OBJECT_NOT_FOUND', `${message}.`)
    : ocflError('OBJECT_NOT_FOUND', `${message}: its storage layout can't place this id.`, { cause: unplaceable });
}

/** For an `objectRoot` with an object declaration and no inventory, which no writer is working on */
function declarationWithoutInventory(objectRoot: string): OcflError {
  return invalidObject(`${objectRoot} has an OCFL object declaration but no inventory.`, { ocflCode: 'E063' });
}

/**
 * The root inventory of the object at `objectRoot`.
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has neither an inventory nor an object declaration
 * @throws {@link OcflError} `INVALID_OBJECT` with E063 if it has a declaration, no inventory and no lock held
 */
async function committedInventory(storageRoot: string, objectRoot: string): Promise<OcflObjectInventory | undefined> {
  const inventory = await readInventory(storageRoot, objectRoot);
  if (inventory || !(await hasObjectDeclaration(objectRoot)) || (await isLocked(objectWorkspace(storageRoot, objectRoot)))) {
    return inventory;
  }
  // Its writer may have finished between the two: a create by committing, a remove by deleting it
  const reread = await readInventory(storageRoot, objectRoot);
  if (!reread && (await hasObjectDeclaration(objectRoot))) {
    throw declarationWithoutInventory(objectRoot);
  }
  return reread;
}

const STRAY_CONTENTS = {
  'not empty': "holds files that aren't an OCFL object",
  'a file': 'is a file',
  'below a file': 'is below a file',
} as const satisfies Record<Exclude<fileSystem.DirContents, 'empty'>, string>;

/** For an `objectRoot` given to the object `id`, with no object declaration or inventory but `contents` */
function strayContents(objectRoot: string, id: string, contents: Exclude<fileSystem.DirContents, 'empty'>): OcflError {
  return objectRootConflict(objectRoot, id, STRAY_CONTENTS[contents]);
}

/** What is at `objectRoot`, which has no inventory, unless it is empty or has an object declaration */
async function strayAt(objectRoot: string): Promise<Exclude<fileSystem.DirContents, 'empty'> | undefined> {
  const contents = await fileSystem.dirContents(objectRoot);
  return contents === 'empty' || (contents === 'not empty' && (await hasObjectDeclaration(objectRoot))) ? undefined : contents;
}

/** For an `objectRoot` given to the object `id`, with no committed inventory */
async function noCommittedObject(storageRoot: string, objectRoot: string, id: string): Promise<OcflError> {
  // A create writes the declaration first, and a writer holds its lock until it has finished
  if ((await strayAt(objectRoot)) === undefined || (await isLocked(objectWorkspace(storageRoot, objectRoot)))) {
    return objectNotFound(storageRoot, id);
  }
  // A writer may have finished between the two: a remove by deleting what it had left, a failed create by discarding what it made
  const stray = await strayAt(objectRoot);
  return stray === undefined ? objectNotFound(storageRoot, id) : strayContents(objectRoot, id, stray);
}

export {
  assertNoMutableHead,
  checkedDeclaration,
  committedInventory,
  confirmedVersion,
  declarationWithoutInventory,
  declaredVersion,
  enclosingObject,
  hasObjectDeclaration,
  idInRootInventory,
  noCommittedObject,
  objectDeclaration,
  objectNotFound,
  objectState,
  readInventory,
  strayContents,
  withinRootVersion,
};
