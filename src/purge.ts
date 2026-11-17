import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { hasObjectDeclaration } from './declaration.ts';
import type { OcflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { lockKept, markRemoving, releaseLock, takeLock } from './lock.ts';
import type { ObjectPlace } from './object-place.ts';
import { confirmedVersion, declarationWithoutInventory, objectNotFound, strayContents } from './object-root.ts';
import { readInventory } from './root-inventory.ts';
import { clearWorkspace } from './workspace.ts';

const { INVENTORY_NAME, NAMASTE_T } = OcflConstants;

/** Whether `name`, in an object root, is the object's declaration, root inventory or sidecar: what opening the object reads */
function isNeededToOpen(name: string): boolean {
  return name.startsWith(NAMASTE_T) || name.startsWith(INVENTORY_NAME);
}

/**
 * @throws {@link OcflError} `OBJECT_NOT_FOUND` if nothing is at the object root of `place`
 * @throws {@link OcflError} `INVALID_OBJECT` if it has an object declaration but is an object that can't be opened
 * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if it is an object with another id, or has no object declaration but holds something, is a file or is below one
 */
async function assertHoldsObject(place: ObjectPlace, id: string): Promise<void> {
  const { storageRoot, objectRoot } = place;
  const root = await readInventory(place, { callerHoldsLock: true });
  if (!root) {
    const contents = await fileSystem.dirContents(objectRoot);
    if (contents === 'empty') {
      throw objectNotFound(storageRoot, id);
    }
    throw contents === 'not empty' && (await hasObjectDeclaration(objectRoot))
      ? declarationWithoutInventory(objectRoot)
      : strayContents(objectRoot, id, contents);
  }
  await confirmedVersion(place, root.inventory, id);
}

/**
 * Deletes the object root of `place`, and the parent directories that leaves empty.
 * What opening the object reads goes last, so that a reader meanwhile finds the object, not a damaged one.
 */
async function deleteObjectRoot({ storageRoot, objectRoot }: ObjectPlace): Promise<void> {
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

/** For a purge that ended holding its lock */
function recoveryNeeded(objectRoot: string, state: string, advice: string, cause: unknown): OcflError {
  return lockKept(`Purging the object at ${objectRoot} ${state}`, advice, cause);
}

/**
 * Deletes the object `id` that the storage root's layout places at `place`, with every version, and the parent directories that leaves empty.
 * The object's lock is held throughout, and what dead writers left in its workspace directory is removed with it.
 * Once the lock says the object is being deleted, the purge is carried through: by this call, or by recovery.
 * @throws {@link OcflError} `OBJECT_LOCKED` if the object is locked; `UNSUPPORTED_FILESYSTEM` if its lock can't be hard-linked; `OBJECT_NOT_FOUND`, `INVALID_OBJECT` or `OBJECT_ROOT_CONFLICT` if `objectRoot` doesn't hold the object. Nothing is deleted, and a lock this took is released.
 * @throws {@link OcflError} `RECOVERY_NEEDED` if deleting it failed, or its lock couldn't be released; the lock is kept
 */
async function purgeObject(place: ObjectPlace, id: string): Promise<void> {
  const { storageRoot, objectRoot, workspace } = place;
  const lock = await takeLock(workspace, storageRoot, id, true, 'purge');
  try {
    await assertHoldsObject(place, id);
    await markRemoving(workspace, lock);
  } catch (error) {
    try {
      await releaseLock(workspace, storageRoot);
    } catch {
      throw recoveryNeeded(objectRoot, 'was refused, and its lock could not be released', 'then purge the object again', error);
    }
    throw error;
  }
  try {
    await deleteObjectRoot(place);
    await clearWorkspace(workspace);
    await releaseLock(workspace, storageRoot);
  } catch (error) {
    throw recoveryNeeded(objectRoot, 'failed part of the way through', 'which finishes purging it', error);
  }
}

/**
 * Finishes the purge that the dead writer holding the lock of the object at `place` had begun, and releases the lock.
 * The lock goes last, so a failure keeps the object locked.
 */
async function recoverPurge(place: ObjectPlace): Promise<void> {
  await clearWorkspace(place.workspace);
  await deleteObjectRoot(place);
  await releaseLock(place.workspace, place.storageRoot);
}

export { purgeObject, recoverPurge };
