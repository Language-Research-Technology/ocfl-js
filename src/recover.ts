import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflError } from './error.ts';
import type { OcflObjectInventory } from './inventory.ts';
import { readLock, releaseLock } from './lock.ts';
import { readInventory, sidecarDigest } from './ocfl-object.ts';
import * as store from './store.ts';
import { objectWorkspace } from './transaction.ts';
import { hasErrorCode, readIfExists } from './utils.ts';

const { INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

const VERSION_DIRECTORY = /^v\d+$/;
/** The root inventory or its sidecar, as a commit stages it before renaming it into place */
const STAGED_INVENTORY = /^inventory\.json(\.[^.]+)?\.tmp$/;

/** The names in `dir`, or none if nothing can be at its path */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG')) {
      return [];
    }
    throw error;
  }
}

async function removeAll(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Replaces the sidecar of the root inventory if it doesn't record that inventory's digest */
async function completeSidecar(objectRoot: string, inventory: OcflObjectInventory): Promise<void> {
  const sidecar = `${path.join(objectRoot, INVENTORY_NAME)}.${inventory.digestAlgorithm}`;
  if (sidecarDigest(await readIfExists(sidecar)) === inventory._digest) {
    return;
  }
  const staged = `${sidecar}.tmp`;
  await store.writeFile(staged, `${inventory._digest} ${INVENTORY_NAME}`);
  await store.move(staged, sidecar);
}

/**
 * Clears what a dead writer left of the object `id` that the storage root's layout places at `objectRoot`, and releases its lock.
 * What was left before the commit point is discarded, and a committed update is completed. The lock goes last, so a failure keeps the object locked.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object, lock or leftover
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, changing nothing
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if `objectRoot` holds an object with another id, changing nothing
 */
async function recoverObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const inventory = await readInventory(objectRoot);
  if (inventory && inventory.id !== id) {
    throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot} holds the object <${inventory.id}>, not <${id}>.`);
  }
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const [lock, workspaceNames, rootNames] = await Promise.all([readLock(workspace), namesIn(workspace), namesIn(objectRoot)]);
  // Only version directories: with some layouts another object's workspace can be below this one
  const unfinished = workspaceNames.filter((name) => VERSION_DIRECTORY.test(name));
  const declarations = rootNames.filter((name) => name.startsWith(NAMASTE_T + NAMASTE_PREFIX_OBJECT));
  if (!inventory && !lock && unfinished.length === 0 && declarations.length === 0) {
    throw new OcflError('OBJECT_NOT_FOUND', `There is no object <${id}> in the storage root ${storageRoot}, and nothing left of one to recover.`);
  }

  await removeAll(workspace, unfinished);
  // A create writes the declaration before anything else in the object root, so without one nothing there is its
  if (inventory || declarations.length > 0) {
    const named = inventory?.versions ?? {};
    await removeAll(
      objectRoot,
      rootNames.filter((name) => STAGED_INVENTORY.test(name) || (VERSION_DIRECTORY.test(name) && !Object.hasOwn(named, name))),
    );
  }
  if (inventory) {
    await completeSidecar(objectRoot, inventory);
  } else {
    await removeAll(objectRoot, declarations);
    if (lock && !lock.objectRootExisted) {
      await store.removeEmptyAncestors(objectRoot, storageRoot);
    }
  }
  await releaseLock(workspace, storageRoot);
}

export { recoverObject };
