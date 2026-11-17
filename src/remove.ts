import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import type { OcflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { lockKept, markRemoving, releaseLock, takeLock } from './lock.ts';
import { confirmedVersion, declarationWithoutInventory, hasObjectDeclaration, objectNotFound, readInventory, strayContents } from './object-on-disk.ts';
import { clearWorkspace, objectWorkspace } from './workspace.ts';

const { INVENTORY_NAME, NAMASTE_T } = OcflConstants;

/** Whether `name`, in an object root, is the object's declaration, root inventory or sidecar: what opening the object reads */
function isNeededToOpen(name: string): boolean {
  return name.startsWith(NAMASTE_T) || name.startsWith(INVENTORY_NAME);
}

/**
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if nothing is at `objectRoot`
 * @throws {@link OcflError} `INVALID_OBJECT` if it has an object declaration but is an object that can't be opened
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it is an object with another id, or has no object declaration but holds something, is a file or is below one
 */
async function assertHoldsObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const inventory = await readInventory(storageRoot, objectRoot, { callerHoldsLock: true });
  if (!inventory) {
    const contents = await fileSystem.dirContents(objectRoot);
    if (contents === 'empty') {
      throw objectNotFound(storageRoot, id);
    }
    throw contents === 'not empty' && (await hasObjectDeclaration(objectRoot))
      ? declarationWithoutInventory(objectRoot)
      : strayContents(objectRoot, id, contents);
  }
  await confirmedVersion(storageRoot, objectRoot, inventory, id);
}

/**
 * Deletes the object root at `objectRoot`, and the parent directories that leaves empty.
 * What opening the object reads goes last, so that a reader meanwhile finds the object, not a damaged one.
 */
async function deleteObjectRoot(storageRoot: string, objectRoot: string): Promise<void> {
  const names = await fs.promises.readdir(objectRoot).catch((error) => {
    if (fileSystem.isNotFound(error)) {
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
  await fileSystem.removeEmptyAncestorsQuietly(path.dirname(objectRoot), storageRoot);
}

/** For a remove that ended holding its lock */
function recoveryNeeded(objectRoot: string, state: string, advice: string, cause: unknown): OcflError {
  return lockKept(`Removing the object at ${objectRoot} ${state}`, advice, cause);
}

/**
 * Deletes the object `id` that the storage root's layout places at `objectRoot`, with every version, and the parent directories that leaves empty.
 * The object's lock is held throughout, and what dead writers left in its workspace directory is removed with it.
 * Once the lock says the object is being removed, the remove is carried through: by this call, or by recovery.
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if the object is locked; `UNSUPPORTED_FILESYSTEM` if its lock can't be hard-linked; `OBJECT_NOT_FOUND`, `INVALID_OBJECT` or `OBJECT_ROOT_CONFLICT` if `objectRoot` doesn't hold the object. Nothing is deleted, and a lock this took is released.
 * @throws {@link OcflError} `RECOVERY_NEEDED` if deleting it failed, or its lock couldn't be released; the lock is kept
 */
async function removeObject(storageRoot: string, objectRoot: string, id: string): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const lock = await takeLock(workspace, storageRoot, id, true);
  try {
    await assertHoldsObject(storageRoot, objectRoot, id);
    await markRemoving(workspace, lock);
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
    await clearWorkspace(workspace);
    await releaseLock(workspace, storageRoot);
  } catch (error) {
    throw recoveryNeeded(objectRoot, 'failed part of the way through', 'which finishes removing it', error);
  }
}

/**
 * Finishes the remove that the dead writer holding the lock of the object at `objectRoot` had begun, and releases the lock.
 * The lock goes last, so a failure keeps the object locked.
 */
async function recoverRemove(storageRoot: string, objectRoot: string): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  await clearWorkspace(workspace);
  await deleteObjectRoot(storageRoot, objectRoot);
  await releaseLock(workspace, storageRoot);
}

export { recoverRemove, removeObject };
