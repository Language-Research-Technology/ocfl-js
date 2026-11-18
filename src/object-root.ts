import path from 'node:path';
import { OCFL_CONSTANTS, type OcflSpecVersion } from './constants.ts';
import { findDeclaredVersion, hasObjectDeclaration, objectDeclaration } from './declaration.ts';
import { type OcflError, objectRootConflict, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { OcflObjectInventory } from './inventory.ts';
import { isLocked } from './lock.ts';
import type { ObjectPlace } from './object-place.ts';
import { type FaultAt, specViolation } from './ocfl-rules.ts';
import { type RootInventory, readInventory } from './root-inventory.ts';

const { EXTENSIONS_DIR, INVENTORY_NAME, OBJECT_DECLARATION_PREFIX } = OCFL_CONSTANTS;
const MUTABLE_HEAD_INVENTORY = path.join(EXTENSIONS_DIR, '0005-mutable-head', 'head', INVENTORY_NAME);

/** @throws {@link OcflError} `MUTABLE_HEAD_ACTIVE`, with `message`, if the object `id` has an active mutable head (extension 0005) */
export async function assertNoMutableHead(objectRoot: string, id: string, message: string): Promise<void> {
  if (await fileSystem.pathExists(path.join(objectRoot, MUTABLE_HEAD_INVENTORY))) {
    throw ocflError('MUTABLE_HEAD_ACTIVE', message, { objectId: id });
  }
}

/** For an `objectRoot` that the storage layout gives to the object `id`, and that holds the object `found` */
function holdsAnotherObject(objectRoot: string, found: string, id: string): OcflError {
  return objectRootConflict(objectRoot, id, `holds the object <${found}>`);
}

/** The nearest directory between the storage root and the object root of `place` that is itself an object, if any */
export async function enclosingObject({ storageRoot, objectRoot }: ObjectPlace): Promise<string | undefined> {
  const ancestors: string[] = [];
  for (let dir = path.dirname(objectRoot); dir.startsWith(storageRoot + path.sep); dir = path.dirname(dir)) {
    ancestors.push(dir);
  }
  const declared = await Promise.all(ancestors.map((dir) => findDeclaredVersion(OBJECT_DECLARATION_PREFIX, dir)));
  return ancestors.find((_dir, i) => declared[i]);
}

/**
 * What a create finds at `place`, unread and unchecked: a committed object, which has a root inventory or an object declaration with no lock held;
 * a create that holds its lock and hasn't committed; or neither
 */
export async function objectState(place: ObjectPlace): Promise<'committed' | 'creating' | 'none'> {
  const { objectRoot } = place;
  const [hasInventory, declared] = await Promise.all([fileSystem.pathExists(path.join(objectRoot, INVENTORY_NAME)), hasObjectDeclaration(objectRoot)]);
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
 * @param id - The id `place` is given to, for the error
 * @throws {@link OcflError} `INVALID_OBJECT` if its declaration is missing (`E003`) or wrong as `checkedDeclaration` finds it, or it is inside another object
 */
export async function declaredVersion(place: ObjectPlace, id: string): Promise<OcflSpecVersion> {
  const { objectRoot } = place;
  const where: FaultAt = { objectId: id, file: objectRoot };
  const [ocflVersion, outer] = await Promise.all([objectDeclaration(objectRoot, where), enclosingObject(place)]);
  if (!ocflVersion) {
    throw specViolation('E003', where, 'it has an inventory but no object declaration');
  }
  if (outer !== undefined) {
    throw nestedObject(where, outer);
  }
  return ocflVersion;
}

/**
 * The OCFL version declared by the object at `place`, whose root inventory is `inventory`, once it is known to be the object `id`.
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link declaredVersion} does
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it is an object with another id
 */
export async function confirmedVersion(place: ObjectPlace, inventory: OcflObjectInventory, id: string): Promise<OcflSpecVersion> {
  const ocflVersion = await declaredVersion(place, id);
  if (inventory.id !== id) {
    throw holdsAnotherObject(place.objectRoot, inventory.id, id);
  }
  return ocflVersion;
}

/**
 * `ocflVersion`, declared by the object `where` is, once it is known to be no later than `rootVersion`, its storage root's.
 * @throws {@link OcflError} `INVALID_OBJECT` with E081 if it is later
 */
export function withinRootVersion(where: FaultAt, ocflVersion: OcflSpecVersion, rootVersion: OcflSpecVersion): OcflSpecVersion {
  if (ocflVersion > rootVersion) {
    throw specViolation('E081', where, `an OCFL ${ocflVersion} object in an OCFL ${rootVersion} storage root`);
  }
  return ocflVersion;
}

/** For the object `where` is, which is inside the object at `outer` */
function nestedObject(where: FaultAt, outer: string): OcflError {
  return specViolation('E082', where, `nested under the object at ${outer}`);
}

/** @param unplaceable - The layout's refusal of `id`, if that is why there is no object */
export function objectNotFound(id: string, unplaceable?: OcflError): OcflError {
  const message = `There is no object <${id}> in the storage root`;
  const why = unplaceable === undefined ? '' : ": its storage layout can't place this id";
  return ocflError('OBJECT_NOT_FOUND', `${message}${why}.`, { objectId: id, cause: unplaceable });
}

/** For a create of the object `id`, which already exists */
export function objectExists(id: string): OcflError {
  return ocflError('OBJECT_EXISTS', `The object <${id}> already exists in the storage root.`, { objectId: id });
}

/**
 * For a write to the object `id`, opened at version `opened`, that has changed since
 * @param since - What became of it, continuing "…was opened at v1, and "
 */
export function objectOutOfDate(id: string, opened: string | undefined, since: string): OcflError {
  return ocflError('OBJECT_OUT_OF_DATE', `The object <${id}> was opened at ${opened}, and ${since}. Open it again and retry.`, { objectId: id });
}

/** For an `objectRoot` with an object declaration and no inventory, which no writer is working on */
export function declarationWithoutInventory(objectRoot: string, id?: string): OcflError {
  return specViolation('E063', id === undefined ? objectRoot : { objectId: id, file: objectRoot }, 'an object declaration but no inventory');
}

/**
 * The root inventory of the object at `place`.
 * @returns `undefined` if it has no inventory and its lock is held, a create that isn't committed; or if it has neither an inventory nor an object declaration
 * @param id - The id `place` is given to, if known, for the error
 * @throws {@link OcflError} `INVALID_OBJECT` with E063 if it has a declaration, no inventory and no lock held
 */
export async function committedInventory(place: ObjectPlace, id?: string): Promise<RootInventory | undefined> {
  const { objectRoot } = place;
  const read = await readInventory(place);
  if (read || !(await hasObjectDeclaration(objectRoot)) || (await isLocked(place.workspace))) {
    return read;
  }
  // Its writer may have finished between the two: a create by committing, a purge by deleting it
  const reread = await readInventory(place);
  if (!reread && (await hasObjectDeclaration(objectRoot))) {
    throw declarationWithoutInventory(objectRoot, id);
  }
  return reread;
}

const STRAY_CONTENTS = {
  'not empty': "holds files that aren't an OCFL object",
  'a file': 'is a file',
  'below a file': 'is below a file',
} as const satisfies Record<Exclude<fileSystem.DirContents, 'empty'>, string>;

/** For an `objectRoot` given to the object `id`, with no object declaration or inventory but `contents` */
export function strayContents(objectRoot: string, id: string, contents: Exclude<fileSystem.DirContents, 'empty'>): OcflError {
  return objectRootConflict(objectRoot, id, STRAY_CONTENTS[contents]);
}

/** @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` unless `objectRoot`, given to the object `id`, is empty or missing */
export async function assertEmptyObjectRoot(objectRoot: string, id: string): Promise<void> {
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
export async function noCommittedObject(place: ObjectPlace, id: string): Promise<OcflError> {
  const { objectRoot } = place;
  // A create writes the declaration first, and a writer holds its lock until it has finished
  if ((await strayAt(objectRoot)) === undefined || (await isLocked(place.workspace))) {
    return objectNotFound(id);
  }
  // A writer may have finished between the two: a purge by deleting what it had left, a failed create by discarding what it made
  const stray = await strayAt(objectRoot);
  return stray === undefined ? objectNotFound(id) : strayContents(objectRoot, id, stray);
}
