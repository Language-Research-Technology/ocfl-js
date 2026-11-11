import fs from 'node:fs';
import path from 'node:path';
import { OcflError } from './error.ts';
import * as store from './store.ts';
import { isAlreadyExists, isNotFound, pathExists, readIfExists } from './utils.ts';

const LOCK_NAME = 'lock';
/** The second line of a lock taken when the object root didn't exist, so whatever is there afterwards was made by the lock's writer */
const NO_OBJECT_ROOT = 'no-object-root';
const MAX_LOCK_ATTEMPTS = 3;
/** Longer than a time and {@link NO_OBJECT_ROOT} */
const MAX_LOCK_LENGTH = 64;

interface Lock {
  /** When the lock was taken, if it says */
  lockedAt: Date | undefined;
  /** False only if the lock says its writer found no object root */
  objectRootExisted: boolean;
}

/** The lock of the object whose directory in the workspace is `workspace`: a file holding what {@link formatLock} gives */
function lockPath(workspace: string): string {
  return path.join(workspace, LOCK_NAME);
}

function formatLock(lockedAt: Date, objectRootExisted: boolean): string {
  return lockedAt.toISOString() + (objectRootExisted ? '' : `\n${NO_OBJECT_ROOT}`);
}

function parseLock(content: string): Lock {
  const [time = '', second] = content.split('\n');
  const lockedAt = new Date(time);
  return { lockedAt: Number.isNaN(lockedAt.getTime()) ? undefined : lockedAt, objectRootExisted: second !== NO_OBJECT_ROOT };
}

/** When the lock was taken, or `undefined` if it can't be read or has been released since */
async function readLockedAt(lock: string): Promise<Date | undefined> {
  try {
    const { lockedAt } = parseLock(await fs.promises.readFile(lock, 'utf8'));
    // Without a time, its writer has created the lock but not yet written into it
    return lockedAt ?? (await fs.promises.stat(lock)).mtime;
  } catch {
    return undefined;
  }
}

/**
 * Creates the lock file holding `content`. Exclusive, so of any overlapping writers only one takes the lock.
 * @returns Whether the lock was created: `false` if it already exists
 */
async function createLock(lock: string, content: string): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lock, 'wx');
  } catch (error) {
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  }
  try {
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.promises.rm(lock, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

/** The `UPDATE_IN_PROGRESS` for an object whose lock is held, with `lockedAt` if the lock can still be read */
async function updateInProgress(workspace: string): Promise<OcflError> {
  const lock = lockPath(workspace);
  return new OcflError('UPDATE_IN_PROGRESS', `Another writer is updating the object, and holds its lock ${lock}.`, { lockedAt: await readLockedAt(lock) });
}

/**
 * Takes the object's lock, without waiting for a writer that holds it.
 * @param workspace - The object's directory in the workspace of the storage root at `storageRoot`
 * @param objectRootExists - Recorded in the lock, for {@link readLock}
 * @throws {@link OcflError} `UPDATE_IN_PROGRESS`, with `lockedAt` if the lock can be read, if the lock is already taken
 */
async function takeLock(workspace: string, storageRoot: string, objectRootExists: boolean): Promise<void> {
  if (!(await createLockInWorkspace(workspace, storageRoot, objectRootExists))) {
    throw await updateInProgress(workspace);
  }
}

/** @returns Whether the lock was created: `false` if it already exists */
async function createLockInWorkspace(workspace: string, storageRoot: string, objectRootExists: boolean, attempt = 1): Promise<boolean> {
  try {
    await fs.promises.mkdir(workspace, { recursive: true });
    return await createLock(lockPath(workspace), formatLock(new Date(), objectRootExists));
  } catch (error) {
    // Not found: another update's clean-up removed the empty workspace before the lock was created in it
    if (isNotFound(error) && attempt < MAX_LOCK_ATTEMPTS) {
      return createLockInWorkspace(workspace, storageRoot, objectRootExists, attempt + 1);
    }
    await store.removeEmptyAncestorsQuietly(workspace, storageRoot);
    throw error;
  }
}

/** Removes the object's lock, and the workspace directories that leaves empty */
async function releaseLock(workspace: string, storageRoot: string): Promise<void> {
  await fs.promises.rm(lockPath(workspace), { force: true });
  await store.removeEmptyAncestorsQuietly(workspace, storageRoot);
}

/** What the object's lock records, or `undefined` if the object isn't locked */
async function readLock(workspace: string): Promise<Lock | undefined> {
  const content = await readIfExists(lockPath(workspace));
  return content === undefined ? undefined : parseLock(content);
}

/** Whether `content` is exactly what {@link formatLock} gives */
function isLockContent(content: string): boolean {
  const [time = '', second, ...rest] = content.split('\n');
  const lockedAt = new Date(time);
  return !Number.isNaN(lockedAt.getTime()) && lockedAt.toISOString() === time && (second === undefined || second === NO_OBJECT_ROOT) && rest.length === 0;
}

/** Whether the file named as a lock was written as one, as a file of a version's content wouldn't be */
async function isLock(file: string): Promise<boolean> {
  if ((await fs.promises.stat(file)).size > MAX_LOCK_LENGTH) {
    return false;
  }
  return isLockContent(await fs.promises.readFile(file, 'utf8'));
}

/** Whether the object's lock is held */
async function isLocked(workspace: string): Promise<boolean> {
  return pathExists(lockPath(workspace));
}

export { isLock, isLocked, LOCK_NAME, NO_OBJECT_ROOT, readLock, releaseLock, takeLock, updateInProgress };
