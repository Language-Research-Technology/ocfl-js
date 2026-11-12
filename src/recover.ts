import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { ocflError } from './error.ts';
import { isStagedRootInventory, isVersionName, type OcflObjectInventory, rootInventoryPaths, sidecarContent, sidecarDigest } from './inventory.ts';
import { isLock, LOCK_NAME, readLock, releaseLock } from './lock.ts';
import { declarationWithoutInventory, enclosingObject, holdsAnotherObject, insideAnotherObject, nestedObject, readInventory } from './ocfl-object.ts';
import { deleteObjectRoot } from './remove.ts';
import * as store from './store.ts';
import { objectWorkspace } from './transaction.ts';
import { isNothingAtPath, readIfExists } from './utils.ts';

const { NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;
const FIRST_VERSION = 'v1';

/** What `list` gives for a directory, or nothing if nothing can be at its path */
async function listed<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch (error) {
    if (isNothingAtPath(error)) {
      return [];
    }
    throw error;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  return listed(() => fs.promises.readdir(dir));
}

async function removeAll(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Whether a lock is held anywhere below `dir` */
async function holdsLock(dir: string): Promise<boolean> {
  const entries = await listed(() => fs.promises.readdir(dir, { recursive: true, withFileTypes: true }));
  const candidates = entries.filter((entry) => entry.name === LOCK_NAME && entry.isFile());
  const locks = await Promise.all(candidates.map((entry) => isLock(path.join(entry.parentPath, entry.name))));
  return locks.includes(true);
}

/**
 * The unfinished versions among `names`, the entries of an object's directory in the workspace.
 * A storage root an earlier release or another tool wrote can hold another object's directory in the workspace at or below a version's name, where a live writer of it holds its lock.
 */
async function unfinishedVersions(workspace: string, names: string[]): Promise<string[]> {
  const versions = names.filter(isVersionName);
  const foreign = await Promise.all(versions.map((name) => holdsLock(path.join(workspace, name))));
  return versions.filter((_name, i) => !foreign[i]);
}

/** The name an update of `inventory` gives its version, or `undefined` if there can be no further version */
function nextVersionName(inventory: OcflObjectInventory): string | undefined {
  try {
    return inventory.versionNumber.next().toString();
  } catch {
    return undefined;
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
 * What was left before the commit point is discarded, a committed update is completed, and a remove that had begun deleting is finished. The lock goes last, so a failure keeps the object locked.
 *
 * Only what a dead writer can have left is removed from the object root: the version after the head, or with no root inventory
 * the declaration and first version of a create, which always leaves its lock.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object, lock or leftover
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, the object is inside another object, or it has a declaration and no root inventory but isn't what a dead create leaves; changing nothing
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if `objectRoot` holds an object with another id, or holds no object and is inside one; changing nothing
 */
async function recoverObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const lock = await readLock(workspace);
  if (lock?.removing) {
    await removeAll(workspace, await unfinishedVersions(workspace, await namesIn(workspace)));
    await deleteObjectRoot(storageRoot, objectRoot);
    await releaseLock(workspace, storageRoot);
    return;
  }
  const [inventory, workspaceNames, rootNames, outer] = await Promise.all([
    readInventory(objectRoot),
    namesIn(workspace),
    namesIn(objectRoot),
    enclosingObject(storageRoot, objectRoot),
  ]);
  if (outer !== undefined) {
    throw inventory ? nestedObject(objectRoot, outer) : insideAnotherObject(objectRoot, id, outer);
  }
  if (inventory && inventory.id !== id) {
    throw holdsAnotherObject(objectRoot, inventory.id, id);
  }
  const unfinished = await unfinishedVersions(workspace, workspaceNames);
  const declarations = rootNames.filter((name) => name.startsWith(NAMASTE_T + NAMASTE_PREFIX_OBJECT));
  if (!inventory && !lock && unfinished.length === 0 && declarations.length === 0) {
    throw ocflError('OBJECT_NOT_FOUND', `There is no object <${id}> in the storage root ${storageRoot}, and nothing left of one to recover.`);
  }
  // A create writes the declaration before anything else in the object root, so without one nothing there is its
  const createLeft = !inventory && declarations.length > 0;
  if (createLeft && (!lock || rootNames.some((name) => isVersionName(name) && name !== FIRST_VERSION))) {
    throw declarationWithoutInventory(objectRoot);
  }

  await removeAll(workspace, unfinished);
  if (inventory) {
    const next = nextVersionName(inventory);
    await removeAll(
      objectRoot,
      rootNames.filter((name) => isStagedRootInventory(name) || name === next),
    );
    await completeSidecar(objectRoot, inventory);
  } else {
    if (createLeft) {
      await removeAll(objectRoot, [...rootNames.filter((name) => isStagedRootInventory(name) || name === FIRST_VERSION), ...declarations]);
    }
    if (lock && !lock.objectRootExisted) {
      await store.removeEmptyAncestors(objectRoot, storageRoot);
    }
  }
  await releaseLock(workspace, storageRoot);
}

export { recoverObject };
