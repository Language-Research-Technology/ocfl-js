import fs from 'node:fs';
import path from 'node:path';
import { OCFL_CONSTANTS } from './constants.ts';
import { type DeclarationsFound, findDeclaredVersion } from './declaration.ts';
import { OcflError } from './error.ts';
import { isNothingAtPath, pathFromStorageRoot } from './file-system.ts';
import { type ObjectPlace, objectPlace } from './object-place.ts';
import { type OcflObject, openDeclaredObject } from './ocfl-object.ts';
import { idInRootInventory } from './root-inventory.ts';
import type { RootSettings } from './storage-root.ts';

const { EXTENSIONS_DIR, OBJECT_DECLARATION_PREFIX } = OCFL_CONSTANTS;

/** An object root that {@link StorageRoot.objects} opened. */
export interface ListedOpenedObject {
  /** Always `'opened'`. */
  readonly status: 'opened';
  /** The object, opened. */
  readonly object: OcflObject;
}

/** A damaged object root that {@link StorageRoot.objects} found and couldn't open. */
export interface ListedDamagedObjectRoot {
  /** Always `'damaged'`. */
  readonly status: 'damaged';
  /** Why it can't be opened: always `INVALID_OBJECT`, with `ocflCode` when the fault has one. */
  readonly error: OcflError;
  /** Where it is: its path from the storage root, with `/` between directories, such as `a1b/c2d/item-1`. */
  readonly objectRoot: string;
  /** The id its root inventory names, absent if the inventory can't be read, isn't JSON or names none. It isn't checked against the storage layout. */
  readonly id?: string;
}

/** Options for {@link StorageRoot.objects}. */
export interface ListOptions {
  /** Aborting it stops the listing. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * What {@link StorageRoot.objects} yields for each object root: the object, or why a damaged object root can't be opened.
 * Tell them apart by `status`, and keep a fallback: a later release may add a status. {@link StorageRoot.objects} shows how.
 */
export type ListedObject = ListedOpenedObject | ListedDamagedObjectRoot;

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
 * The object at `place`, or the reason it can't be opened.
 * @returns `undefined` for an object that is being created and isn't committed
 */
async function listedObjectAt(place: ObjectPlace, declared: DeclarationsFound, rootSettings: RootSettings): Promise<ListedObject | undefined> {
  const { storageRoot, objectRoot } = place;
  try {
    const object = await openDeclaredObject(place, declared, rootSettings);
    return object && { status: 'opened', object };
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'INVALID_OBJECT')) {
      throw error;
    }
    const damaged: ListedDamagedObjectRoot = {
      status: 'damaged',
      error,
      objectRoot: pathFromStorageRoot(storageRoot, objectRoot),
    };
    const id = await idInRootInventory(objectRoot);
    return id === undefined ? damaged : { ...damaged, id };
  }
}

/** A directory with an object declaration is an object, valid or not, and isn't searched: OCFL allows no object inside another */
async function* objectsUnder(storageRoot: string, rootSettings: RootSettings, dir: fs.Dir, signal: AbortSignal | undefined): AsyncGenerator<ListedObject> {
  for await (const entry of dir) {
    signal?.throwIfAborted();
    if (!entry.isDirectory() || (dir.path === storageRoot && entry.name === EXTENSIONS_DIR)) {
      continue;
    }
    const entryPath = path.join(dir.path, entry.name);
    const declared = await findDeclaredVersion(OBJECT_DECLARATION_PREFIX, entryPath);
    if (declared === undefined) {
      const subdirectory = await openListedDirectory(entryPath);
      if (subdirectory) {
        yield* objectsUnder(storageRoot, rootSettings, subdirectory, signal);
      }
      continue;
    }
    const found = await listedObjectAt(objectPlace(storageRoot, entryPath), declared, rootSettings);
    signal?.throwIfAborted();
    if (found) {
      yield found;
    }
  }
}

/**
 * Every object root in the storage root at `storageRoot`, with the settings `rootSettings`, each read when the listing reaches it.
 * @throws The file system error that stopped the listing
 */
export async function* listObjects(storageRoot: string, rootSettings: RootSettings, signal: AbortSignal | undefined): AsyncGenerator<ListedObject> {
  signal?.throwIfAborted();
  yield* objectsUnder(storageRoot, rootSettings, await fs.promises.opendir(storageRoot), signal);
}
