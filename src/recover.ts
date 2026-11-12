import { OcflConstants } from './constants.ts';
import { isStagedRootInventory, isVersionName, type OcflObjectInventory, rootInventoryPaths, sidecarContent, sidecarDigest } from './inventory.ts';
import { type Lock, releaseLock } from './lock.ts';
import { declarationWithoutInventory, enclosingObject, readInventory } from './ocfl-object.ts';
import { deleteObjectRoot } from './remove.ts';
import * as store from './store.ts';
import { readIfExists } from './utils.ts';
import { clearWorkspace, namesIn, objectWorkspace, removeAll } from './workspace.ts';

const { NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;
const FIRST_VERSION = 'v1';

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
 * Clears what the dead writer holding `lock` left of the object that the storage root's layout places at `objectRoot`, and releases the lock.
 * What was left before the commit point is discarded, a committed update is completed, and a remove that had begun deleting is finished. The lock goes last, so a failure keeps the object locked.
 *
 * Only what a dead writer can have left is removed from the object root: the version after the head, or with no root inventory
 * the declaration and first version of a create. A writer of an id whose directory holds another object, or is inside one, was refused
 * before it wrote anything there, so the object root is left alone.
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, or the object has a declaration and no root inventory but isn't what a dead create leaves; changing nothing
 */
async function recoverObject(storageRoot: string, objectRoot: string, lock: Lock): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  if (lock.removing) {
    await clearWorkspace(workspace);
    await deleteObjectRoot(storageRoot, objectRoot);
    await releaseLock(workspace, storageRoot);
    return;
  }
  const [inventory, rootNames, outer] = await Promise.all([readInventory(objectRoot), namesIn(objectRoot), enclosingObject(storageRoot, objectRoot)]);
  if (outer !== undefined || (inventory && inventory.id !== lock.id)) {
    await clearWorkspace(workspace);
    await releaseLock(workspace, storageRoot);
    return;
  }
  const declarations = rootNames.filter((name) => name.startsWith(NAMASTE_T + NAMASTE_PREFIX_OBJECT));
  // A create writes the declaration before anything else in the object root, so without one nothing there is its
  const createLeft = !inventory && declarations.length > 0;
  if (createLeft && rootNames.some((name) => isVersionName(name) && name !== FIRST_VERSION)) {
    throw declarationWithoutInventory(objectRoot);
  }

  await clearWorkspace(workspace);
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
    if (!lock.objectRootExisted) {
      await store.removeEmptyAncestors(objectRoot, storageRoot);
    }
  }
  await releaseLock(workspace, storageRoot);
}

export { recoverObject };
