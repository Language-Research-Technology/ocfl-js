import fs from 'node:fs';
import path from 'node:path';
import { OcflError } from './error.ts';
import * as store from './store.ts';
import { isAlreadyExists, isNotFound, readIfExists } from './utils.ts';

const LOCK_NAME = 'lock';
/** The second line of a lock taken when the object root didn't exist, so whatever is there afterwards was made by the lock's writer */
const NO_OBJECT_ROOT = 'no-object-root';
const MAX_LOCK_ATTEMPTS = 3;

/** The lock of the object whose directory in the workspace is `workspace`: a file holding the time it was taken, then {@link NO_OBJECT_ROOT} if that applies */
function lockPath(workspace: string): string {
  return path.join(workspace, LOCK_NAME);
}

/** When the lock was taken, or `undefined` if it has been released since */
async function readLockedAt(lock: string): Promise<Date | undefined> {
  try {
    const [time = ''] = (await fs.promises.readFile(lock, 'utf8')).split('\n');
    const written = new Date(time);
    // Its writer has created the lock but not yet written the time into it
    return Number.isNaN(written.getTime()) ? (await fs.promises.stat(lock)).mtime : written;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Creates the lock file, holding the time and then `rest`. Exclusive, so of any overlapping writers only one takes the lock. */
async function createLock(lock: string, rest: string): Promise<void> {
  const handle = await fs.promises.open(lock, 'wx');
  try {
    await handle.writeFile(new Date().toISOString() + rest);
  } catch (error) {
    await fs.promises.rm(lock, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Takes the object's lock, without waiting for a writer that holds it.
 * @param workspace - The object's directory in the workspace of the storage root at `storageRoot`
 * @param objectRootExists - Recorded in the lock, for {@link readLock}
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS`, with `lockedAt`, if the lock is already taken
 */
async function takeLock(workspace: string, storageRoot: string, objectRootExists: boolean): Promise<void> {
  const lock = lockPath(workspace);
  const rest = objectRootExists ? '' : `\n${NO_OBJECT_ROOT}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.mkdir(workspace, { recursive: true });
      await createLock(lock, rest);
      return;
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new OcflError('UPDATE_IN_PROGRESS', `Another writer is updating the object, and holds its lock ${lock}.`, {
          lockedAt: await readLockedAt(lock),
        });
      }
      // Another update's clean-up removed the empty workspace before the lock was created in it
      if (!isNotFound(error) || attempt === MAX_LOCK_ATTEMPTS) {
        await store.removeEmptyAncestorsQuietly(workspace, storageRoot);
        throw error;
      }
    }
  }
}

/** Removes the object's lock, and the workspace directories that leaves empty */
async function releaseLock(workspace: string, storageRoot: string): Promise<void> {
  await fs.promises.rm(lockPath(workspace), { force: true });
  await store.removeEmptyAncestorsQuietly(workspace, storageRoot);
}

/**
 * What the object's lock records, or `undefined` if the object isn't locked.
 * `objectRootExisted` is false only if the lock says its writer found no object root.
 */
async function readLock(workspace: string): Promise<{ objectRootExisted: boolean } | undefined> {
  const content = await readIfExists(lockPath(workspace));
  return content === undefined ? undefined : { objectRootExisted: content.split('\n')[1] !== NO_OBJECT_ROOT };
}

export { LOCK_NAME, NO_OBJECT_ROOT, readLock, releaseLock, takeLock };
