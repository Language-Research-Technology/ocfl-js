import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflError } from './error.ts';
import { type OcflObject, openDeclaredObject } from './ocfl-object.ts';
import type { OcflVersion } from './types.ts';
import { findNamasteVersion, isNothingAtPath } from './utils.ts';

const { EXTENSIONS_DIR, NAMASTE_PREFIX_OBJECT } = OcflConstants;

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
async function objectOrError(storageRoot: string, objectRoot: string, declared: OcflVersion | ''): Promise<OcflObject | OcflError | undefined> {
  try {
    return await openDeclaredObject(storageRoot, objectRoot, declared);
  } catch (error) {
    if (error instanceof OcflError && error.code === 'INVALID_OBJECT') {
      return error;
    }
    throw error;
  }
}

/** A directory with an object declaration is an object, valid or not, and isn't searched: OCFL allows no object inside another */
async function* objectsUnder(storageRoot: string, dir: fs.Dir): AsyncGenerator<OcflObject | OcflError> {
  for await (const entry of dir) {
    if (!entry.isDirectory() || (dir.path === storageRoot && entry.name === EXTENSIONS_DIR)) {
      continue;
    }
    const entryPath = path.join(dir.path, entry.name);
    const declared = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, entryPath);
    if (declared === undefined) {
      const subdirectory = await openListedDirectory(entryPath);
      if (subdirectory) {
        yield* objectsUnder(storageRoot, subdirectory);
      }
      continue;
    }
    const found = await objectOrError(storageRoot, entryPath, declared);
    if (found) {
      yield found;
    }
  }
}

/**
 * Every object in the storage root at `storageRoot`, each read when the listing reaches it. One that can't be opened is yielded as its `INVALID_OBJECT` error.
 * @throws The file system error that stopped the listing
 */
async function* listObjects(storageRoot: string): AsyncGenerator<OcflObject | OcflError> {
  yield* objectsUnder(storageRoot, await fs.promises.opendir(storageRoot));
}

export { listObjects };
