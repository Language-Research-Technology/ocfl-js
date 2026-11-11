import fs from 'node:fs';
import path from 'node:path';
import { OcflError } from './error.ts';
import * as store from './store.ts';
import { isAlreadyExists, isNotFound } from './utils.ts';

const LOCK_NAME = 'lock';
const MAX_LOCK_ATTEMPTS = 3;

/** The lock of the object whose directory in the workspace is `workspace`: a file holding the time it was taken */
function lockPath(workspace: string): string {
  return path.join(workspace, LOCK_NAME);
}

/** When the lock was taken, or `undefined` if it has been released since */
async function readLockedAt(lock: string): Promise<Date | undefined> {
  try {
    const written = new Date(await fs.promises.readFile(lock, 'utf8'));
    // Its writer has created the lock but not yet written the time into it
    return Number.isNaN(written.getTime()) ? (await fs.promises.stat(lock)).mtime : written;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function removeEmptyWorkspace(workspace: string, storageRoot: string): Promise<void> {
  // A leftover empty directory is harmless, so failing to remove one must not mask the update's outcome
  await store.removeEmptyAncestors(workspace, storageRoot).catch(() => {});
}

/**
 * Takes the object's lock, without waiting for a writer that holds it.
 * @param workspace - The object's directory in the workspace of the storage root at `storageRoot`
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS`, with `lockedAt`, if the lock is already taken
 */
async function takeLock(workspace: string, storageRoot: string): Promise<void> {
  const lock = lockPath(workspace);
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.mkdir(workspace, { recursive: true });
      // Exclusive, so of any overlapping writers only one takes the lock
      const handle = await fs.promises.open(lock, 'wx');
      try {
        await handle.writeFile(new Date().toISOString());
      } catch (error) {
        await fs.promises.rm(lock, { force: true }).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new OcflError('UPDATE_IN_PROGRESS', `Another writer is updating the object, and holds its lock ${lock}.`, {
          lockedAt: await readLockedAt(lock),
        });
      }
      // Another update's clean-up removed the empty workspace before the lock was created in it
      if (!isNotFound(error) || attempt === MAX_LOCK_ATTEMPTS) {
        await removeEmptyWorkspace(workspace, storageRoot);
        throw error;
      }
    }
  }
}

/** Removes the object's lock, and the workspace directories that leaves empty */
async function releaseLock(workspace: string, storageRoot: string): Promise<void> {
  await fs.promises.rm(lockPath(workspace), { force: true });
  await removeEmptyWorkspace(workspace, storageRoot);
}

export { releaseLock, takeLock };
