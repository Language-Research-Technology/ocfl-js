import nodePath from 'node:path';
import { OcflConstants, type OcflSpecVersion } from './constants.ts';
import { findDeclaredVersion, hasObjectDeclaration, objectDeclaration } from './declaration.ts';
import { type OcflError, objectRootConflict, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { OcflObjectInventory } from './inventory.ts';
import { isLocked } from './lock.ts';
import type { ObjectPlace } from './object-place.ts';
import { specViolation } from './ocfl-rules.ts';
import { type RootInventory, readInventory } from './root-inventory.ts';

const { EXTENSIONS_DIR, INVENTORY_NAME, OBJECT_DECLARATION_PREFIX } = OcflConstants;
const MUTABLE_HEAD_INVENTORY = nodePath.join(EXTENSIONS_DIR, '0005-mutable-head', 'head', INVENTORY_NAME);

/** @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE`, with `message`, if the object has an active mutable head (extension 0005) */
async function assertNoMutableHead(objectRoot: string, message: string): Promise<void> {
  if (await fileSystem.pathExists(nodePath.join(objectRoot, MUTABLE_HEAD_INVENTORY))) {
    throw ocflError('MUTABLE_HEAD_ACTIVE', message);
  }
}

/** For an `objectRoot` that the storage layout gives to the object `id`, and that holds the object `found` */
function holdsAnotherObject(objectRoot: string, found: string, id: string): OcflError {
  return objectRootConflict(objectRoot, id, `holds the object <${found}>`);
}

/** The nearest directory between the storage root and the object root of `place` that is itself an object, if any */
async function enclosingObject({ storageRoot, objectRoot }: ObjectPlace): Promise<string | undefined> {
  const ancestors: string[] = [];
  for (let dir = nodePath.dirname(objectRoot); dir.startsWith(storageRoot + nodePath.sep); dir = nodePath.dirname(dir)) {
    ancestors.push(dir);
  }
  const declared = await Promise.all(ancestors.map((dir) => findDeclaredVersion(OBJECT_DECLARATION_PREFIX, dir)));
  return ancestors.find((_dir, i) => declared[i]);
}

/**
 * What a create finds at `place`, unread and unchecked: a committed object, which has a root inventory or an object declaration with no lock held;
 * a create that holds its lock and hasn't committed; or neither
 */
async function objectState(place: ObjectPlace): Promise<'committed' | 'creating' | 'none'> {
  const { objectRoot } = place;
  const [hasInventory, declared] = await Promise.all([fileSystem.pathExists(nodePath.join(objectRoot, INVENTORY_NAME)), hasObjectDeclaration(objectRoot)]);
  if (hasInventory) {
    return 'committed';
  }
  if (!declared) {
    return 'none';
  }
  return (await isLocked(place.workspace)) ? 'creating' : 'committed';
}

/**
 * The OCFL version declared by the object at `place`, which has an inventory.
 * @throws {@link OcflError} `INVALID_OBJECT` if its declaration is missing (`E003`) or wrong as `checkedDeclaration` finds it, or it is inside another object
 */
async function declaredVersion(place: ObjectPlace): Promise<OcflSpecVersion> {
  const { objectRoot } = place;
  const [ocflVersion, outer] = await Promise.all([objectDeclaration(objectRoot), enclosingObject(place)]);
  if (!ocflVersion) {
    throw specViolation('E003', objectRoot, 'it has an inventory but no object declaration');
  }
  if (outer !== undefined) {
    throw nestedObject(objectRoot, outer);
  }
  return ocflVersion;
}

/**
 * The OCFL version declared by the object at `place`, whose root inventory is `inventory`, once it is known to be the object `id`.
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link declaredVersion} does
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it is an object with another id
 */
async function confirmedVersion(place: ObjectPlace, inventory: OcflObjectInventory, id: string): Promise<OcflSpecVersion> {
  const ocflVersion = await declaredVersion(place);
  if (inventory.id !== id) {
    throw holdsAnotherObject(place.objectRoot, inventory.id, id);
  }
  return ocflVersion;
}

/**
 * `ocflVersion`, declared by the object at `objectRoot`, once it is known to be no later than `rootVersion`, its storage root's.
 * @throws {@link OcflError} `INVALID_OBJECT` with E081 if it is later
 */
function withinRootVersion(objectRoot: string, ocflVersion: OcflSpecVersion, rootVersion: OcflSpecVersion): OcflSpecVersion {
  if (ocflVersion > rootVersion) {
    throw specViolation('E081', objectRoot, `an OCFL ${ocflVersion} object in an OCFL ${rootVersion} storage root`);
  }
  return ocflVersion;
}

/** For an object at `objectRoot`, which is inside the object at `outer` */
function nestedObject(objectRoot: string, outer: string): OcflError {
  return specViolation('E082', objectRoot, `nested under the object at ${outer}`);
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
  return specViolation('E063', objectRoot, 'an object declaration but no inventory');
}

/**
 * The root inventory of the object at `place`.
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has neither an inventory nor an object declaration
 * @throws {@link OcflError} `INVALID_OBJECT` with E063 if it has a declaration, no inventory and no lock held
 */
async function committedInventory(place: ObjectPlace): Promise<RootInventory | undefined> {
  const { objectRoot } = place;
  const read = await readInventory(place);
  if (read || !(await hasObjectDeclaration(objectRoot)) || (await isLocked(place.workspace))) {
    return read;
  }
  // Its writer may have finished between the two: a create by committing, a purge by deleting it
  const reread = await readInventory(place);
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

/** @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` unless `objectRoot`, given to the object `id`, is empty or missing */
async function assertEmptyObjectRoot(objectRoot: string, id: string): Promise<void> {
  const contents = await fileSystem.dirContents(objectRoot);
  if (contents !== 'empty') {
    throw strayContents(objectRoot, id, contents);
  }
}

/** What is at `objectRoot`, which has no inventory, unless it is empty or has an object declaration */
async function strayAt(objectRoot: string): Promise<Exclude<fileSystem.DirContents, 'empty'> | undefined> {
  const contents = await fileSystem.dirContents(objectRoot);
  return contents === 'empty' || (contents === 'not empty' && (await hasObjectDeclaration(objectRoot))) ? undefined : contents;
}

/** For the object root of `place`, given to the object `id`, with no committed inventory */
async function noCommittedObject(place: ObjectPlace, id: string): Promise<OcflError> {
  const { storageRoot, objectRoot } = place;
  // A create writes the declaration first, and a writer holds its lock until it has finished
  if ((await strayAt(objectRoot)) === undefined || (await isLocked(place.workspace))) {
    return objectNotFound(storageRoot, id);
  }
  // A writer may have finished between the two: a purge by deleting what it had left, a failed create by discarding what it made
  const stray = await strayAt(objectRoot);
  return stray === undefined ? objectNotFound(storageRoot, id) : strayContents(objectRoot, id, stray);
}

export {
  assertEmptyObjectRoot,
  assertNoMutableHead,
  committedInventory,
  confirmedVersion,
  declarationWithoutInventory,
  declaredVersion,
  enclosingObject,
  noCommittedObject,
  objectNotFound,
  objectState,
  strayContents,
  withinRootVersion,
};
