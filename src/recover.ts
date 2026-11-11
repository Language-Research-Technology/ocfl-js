import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflError } from './error.ts';
import { isStagedRootInventory, isVersionName, type OcflObjectInventory, rootInventoryPaths, sidecarContent, sidecarDigest } from './inventory.ts';
import { readLock, releaseLock } from './lock.ts';
import { holdsAnotherObject, readInventory } from './ocfl-object.ts';
import * as store from './store.ts';
import { objectWorkspace } from './transaction.ts';
import { isNothingAtPath, readIfExists } from './utils.ts';

const { NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

/** The names in `dir`, or none if nothing can be at its path */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (error) {
    if (isNothingAtPath(error)) {
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
  const { sidecar, stagedSidecar } = rootInventoryPaths(objectRoot, inventory.digestAlgorithm);
  if (sidecarDigest(await readIfExists(sidecar)) === inventory._digest) {
    return;
  }
  await store.writeFile(stagedSidecar, sidecarContent(inventory));
  await store.move(stagedSidecar, sidecar);
}

/**
 * Clears what a dead writer left of the object `id` that the storage root's layout places at `objectRoot`, and releases its lock.
 * What was left before the commit point is discarded, and a committed update is completed. The lock goes last, so a failure keeps the object locked.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object, lock or leftover
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, changing nothing
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if `objectRoot` holds an object with another id, changing nothing
 */
async function recoverObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const [inventory, lock, workspaceNames, rootNames] = await Promise.all([
    readInventory(objectRoot),
    readLock(workspace),
    namesIn(workspace),
    namesIn(objectRoot),
  ]);
  if (inventory && inventory.id !== id) {
    throw holdsAnotherObject(objectRoot, inventory.id, id);
  }
  // Only version directories: with some layouts another object's workspace can be below this one
  const unfinished = workspaceNames.filter(isVersionName);
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
      rootNames.filter((name) => isStagedRootInventory(name) || (isVersionName(name) && !Object.hasOwn(named, name))),
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
