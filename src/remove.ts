import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { OcflError } from './error.ts';
import { lockKept, markRemoving, releaseLock, takeLock } from './lock.ts';
import { confirmedVersion, declarationWithoutInventory, hasObjectDeclaration, objectNotFound, readInventory } from './ocfl-object.ts';
import * as store from './store.ts';
import { objectWorkspace } from './transaction.ts';
import { hasErrorCode, isDirEmpty } from './utils.ts';

const { INVENTORY_NAME, NAMASTE_T } = OcflConstants;

/** Whether `name`, in an object root, is the object's declaration, root inventory or sidecar: what opening the object reads */
function isNeededToOpen(name: string): boolean {
  return name.startsWith(NAMASTE_T) || name.startsWith(INVENTORY_NAME);
}

/**
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if nothing is at `objectRoot`
 * @throws {@link OcflError} `INVALID_OBJECT` if what is there isn't an object that can be opened
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if it is an object with another id
 */
async function assertHoldsObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const inventory = await readInventory(objectRoot);
  if (!inventory) {
    if (await isDirEmpty(objectRoot)) {
      throw objectNotFound(storageRoot, id);
    }
    throw (await hasObjectDeclaration(objectRoot))
      ? declarationWithoutInventory(objectRoot)
      : new OcflError('INVALID_OBJECT', `${objectRoot}, where the storage root places <${id}>, is not an OCFL object.`);
  }
  await confirmedVersion(storageRoot, objectRoot, inventory, id);
}

/**
 * Deletes the object root at `objectRoot`, and the parent directories that leaves empty.
 * What opening the object reads goes last, so that a reader meanwhile finds the object, not a damaged one.
 */
async function deleteObjectRoot(storageRoot: string, objectRoot: string): Promise<void> {
  const names = await fs.promises.readdir(objectRoot).catch((error) => {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  });
  for (const name of names) {
    if (!isNeededToOpen(name)) {
      await fs.promises.rm(path.join(objectRoot, name), { recursive: true, force: true });
    }
  }
  await fs.promises.rm(objectRoot, { recursive: true, force: true });
  await store.removeEmptyAncestorsQuietly(path.dirname(objectRoot), storageRoot);
}

/** For a remove that ended holding its lock */
function recoveryNeeded(objectRoot: string, state: string, advice: string, cause: unknown): OcflError {
  return lockKept(`Removing the object at ${objectRoot} ${state}`, advice, cause);
}

/**
 * Takes the lock of the object `id`, as {@link takeLock} does.
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if its path is too long for anything to be there
 */
async function takeLockToRemove(storageRoot: string, workspace: string, id: string): Promise<void> {
  try {
    await takeLock(workspace, storageRoot, true);
  } catch (error) {
    throw hasErrorCode(error, 'ENAMETOOLONG') ? objectNotFound(storageRoot, id) : error;
  }
}

/**
 * Deletes the object `id` that the storage root's layout places at `objectRoot`, with every version, and the parent directories that leaves empty.
 * The object's lock is held throughout, and nothing else in its workspace directory is touched.
 * Once the lock says the object is being removed, the remove is carried through: by this call, or by recovery.
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if the object is locked; `OBJECT_NOT_FOUND`, `INVALID_OBJECT` or `ID_INCOMPATIBLE_WITH_LAYOUT` if `objectRoot` doesn't hold the object. Nothing is deleted.
 * @throws {@link OcflError} `RECOVERY_NEEDED` if deleting it failed, or its lock couldn't be released; the lock is kept
 */
async function removeObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  await takeLockToRemove(storageRoot, workspace, id);
  try {
    await assertHoldsObject(storageRoot, objectRoot, id);
    await markRemoving(workspace);
  } catch (error) {
    try {
      await releaseLock(workspace, storageRoot);
    } catch {
      throw recoveryNeeded(objectRoot, 'was refused, and its lock could not be released', 'then remove the object again', error);
    }
    throw error;
  }
  try {
    await deleteObjectRoot(storageRoot, objectRoot);
    await releaseLock(workspace, storageRoot);
  } catch (error) {
    throw recoveryNeeded(objectRoot, 'failed part of the way through', 'which finishes removing it', error);
  }
}

export { deleteObjectRoot, removeObject };
