import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants, type OcflVersion } from './constants.ts';
import { OcflError } from './error.ts';
import { idInRootInventory, type OcflObject, openDeclaredObject } from './ocfl-object.ts';
import { findNamasteVersion, isNothingAtPath } from './utils.ts';

const { EXTENSIONS_DIR, NAMASTE_PREFIX_OBJECT } = OcflConstants;

/**
 * What {@link StorageRoot.objects} yields for each object root: the object, or why a damaged object root can't be opened.
 * Test `'object' in entry` or `'error' in entry`.
 */
type ListedObject =
  | {
      /** The object, opened. */
      readonly object: OcflObject;
    }
  | {
      /** Why it can't be opened: always `INVALID_OBJECT`, with `ocflCode` when the fault has one. */
      readonly error: OcflError;
      /** Where it is: its path from the storage root, with `/` between directories, such as `a1b/c2d/item-1`. */
      readonly objectRoot: string;
      /** The id its root inventory names, absent if the inventory can't be read, isn't JSON or names none. It isn't checked against the storage layout. */
      readonly id?: string;
    };

/** The directory at `dirPath`, or `undefined` if it has gone since it was listed */
async function openListedDirectory(dirPath: string): Promise<fs.Dir | undefined> {
  try {
    return await fs.promises.opendir(dirPath);
  } catch (error) {
    if (isNothingAtPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The object at `objectRoot`, or the reason it can't be opened.
 * @returns `undefined` for an object that is being created and isn't committed
 */
async function listedObjectAt(
  storageRoot: string,
  objectRoot: string,
  declared: OcflVersion | '',
  rootVersion: OcflVersion,
): Promise<ListedObject | undefined> {
  try {
    const object = await openDeclaredObject(storageRoot, objectRoot, declared, rootVersion);
    return object && { object };
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'INVALID_OBJECT')) {
      throw error;
    }
    const damaged = { error, objectRoot: path.relative(storageRoot, objectRoot).split(path.sep).join('/') };
    const id = await idInRootInventory(objectRoot);
    return id === undefined ? damaged : { ...damaged, id };
  }
}

/** A directory with an object declaration is an object, valid or not, and isn't searched: OCFL allows no object inside another */
async function* objectsUnder(storageRoot: string, rootVersion: OcflVersion, dir: fs.Dir): AsyncGenerator<ListedObject> {
  for await (const entry of dir) {
    if (!entry.isDirectory() || (dir.path === storageRoot && entry.name === EXTENSIONS_DIR)) {
      continue;
    }
    const entryPath = path.join(dir.path, entry.name);
    const declared = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, entryPath);
    if (declared === undefined) {
      const subdirectory = await openListedDirectory(entryPath);
      if (subdirectory) {
        yield* objectsUnder(storageRoot, rootVersion, subdirectory);
      }
      continue;
    }
    const found = await listedObjectAt(storageRoot, entryPath, declared, rootVersion);
    if (found) {
      yield found;
    }
  }
}

/**
 * Every object root in the storage root at `storageRoot`, of OCFL version `rootVersion`, each read when the listing reaches it.
 * @throws The file system error that stopped the listing
 */
async function* listObjects(storageRoot: string, rootVersion: OcflVersion): AsyncGenerator<ListedObject> {
  yield* objectsUnder(storageRoot, rootVersion, await fs.promises.opendir(storageRoot));
}

export { type ListedObject, listObjects };
