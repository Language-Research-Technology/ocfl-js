/**
 * Each object's lock keeps its writers apart. A held lock refuses every other writer and is never expired, since nothing on shared
 * storage tells a dead writer from a slow one: it records no process id, host or heartbeat, and no operating-system file lock is used.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type OcflError, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { parseJsonObject } from './utils.ts';

const LOCK_NAME = 'lock';
/** Prefix of the file a lock's content is written to before it is put in place, so a lock is never seen half-written */
const STAGED_LOCK_PREFIX = '.lock-';
const MAX_LOCK_ATTEMPTS = 3;
/** Larger than the lock of any sane id, so a large file named `lock` is known not to be one without reading all of it */
const MAX_LOCK_LENGTH = 64 * 1024;

type Operation = 'create' | 'update' | 'purge';
const OPERATIONS: Record<Operation, true> = { create: true, update: true, purge: true };

function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && Object.hasOwn(OPERATIONS, value);
}

interface Lock {
  /** The id of the object its writer is creating, updating or purging */
  id: string;
  /** What its writer is doing to the object */
  operation: Operation;
  /** When the lock was taken */
  lockedAt: Date;
  /** False if its writer found no object root, so whatever is there afterwards it made */
  objectRootExisted: boolean;
  /** Whether its writer had begun deleting the object root: only ever for a purge */
  removing: boolean;
}

/** The lock of the object whose directory in the workspace is `workspace`: a file holding what {@link formatLock} gives */
function lockPath(workspace: string): string {
  return path.join(workspace, LOCK_NAME);
}

/** A path beside `lock`, where no other writer stages a lock's content */
function stagedLockPath(lock: string): string {
  return path.join(path.dirname(lock), `${STAGED_LOCK_PREFIX}${randomUUID()}`);
}

function formatLock({ id, operation, lockedAt, objectRootExisted, removing }: Lock): string {
  return JSON.stringify({ id, operation, lockedAt: lockedAt.toISOString(), objectRootExisted, ...(removing ? { removing } : {}) });
}

/** The operation of a lock written before locks recorded one */
function inferredOperation(objectRootExisted: boolean, removing: boolean): Operation {
  if (removing) {
    return 'purge';
  }
  return objectRootExisted ? 'update' : 'create';
}

/**
 * What `content` records if it has the fields {@link formatLock} gives, or `undefined`. Other fields, which a later release may add, are ignored.
 * A lock with no `operation`, as earlier releases wrote, is given the likeliest one, and one recording `'remove'`, as releases
 * before `purge` wrote, is given `'purge'`.
 */
function parseLock(content: string): Lock | undefined {
  const { id, operation: recorded, lockedAt, objectRootExisted, removing } = parseJsonObject(content) ?? {};
  const operation = recorded === 'remove' ? 'purge' : recorded;
  if (typeof id !== 'string' || id === '' || typeof lockedAt !== 'string' || typeof objectRootExisted !== 'boolean') {
    return undefined;
  }
  if ((removing !== undefined && removing !== true) || (operation !== undefined && !isOperation(operation))) {
    return undefined;
  }
  if (removing === true && operation !== undefined && operation !== 'purge') {
    return undefined;
  }
  const time = new Date(lockedAt);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== lockedAt) {
    return undefined;
  }
  return {
    id,
    operation: isOperation(operation) ? operation : inferredOperation(objectRootExisted, removing === true),
    lockedAt: time,
    objectRootExisted,
    removing: removing === true,
  };
}

/**
 * Whether two locks were taken by the same writer, whether or not it has since begun deleting the object.
 * `operation` isn't compared: a purge from a release before locks recorded one has none, and is read as another operation until it begins deleting.
 */
function sameWriter(a: Lock, b: Lock): boolean {
  return a.id === b.id && a.lockedAt.getTime() === b.lockedAt.getTime() && a.objectRootExisted === b.objectRootExisted;
}

/** What the file `file` records if it is a lock, or `undefined` if it isn't one or nothing is there */
async function readLockFile(file: string): Promise<Lock | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (error) {
    if (fileSystem.isNothingAtPath(error)) {
      return undefined;
    }
    throw error;
  }
  let content: string | undefined;
  try {
    const buffer = Buffer.alloc(MAX_LOCK_LENGTH + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, length));
    }
    content = length > MAX_LOCK_LENGTH ? undefined : buffer.toString('utf8', 0, length);
  } catch (error) {
    if (!fileSystem.hasErrorCode(error, 'EISDIR')) {
      throw error;
    }
  } finally {
    await handle.close();
  }
  return content === undefined ? undefined : parseLock(content);
}

/** What the object's lock records, or `undefined` if the object isn't locked or its lock isn't one this library wrote */
function readLock(workspace: string): Promise<Lock | undefined> {
  return readLockFile(lockPath(workspace));
}

/** When the lock was taken, or `undefined` if it can't be read or has been released since */
async function readLockedAt(lock: string): Promise<Date | undefined> {
  return (await readLockFile(lock).catch(() => undefined))?.lockedAt;
}

/** Writes `content` to the new file `file`, and flushes it to disk, so a crash can't leave it empty once it is in place */
async function writeDurably(file: string, content: string): Promise<void> {
  const handle = await fs.promises.open(file, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Puts `content` at `lock` whole: it is staged beside the lock under a name no other writer uses, then hard-linked to the lock if
 * `exclusive`, which fails if the lock exists, NFS included, or else renamed over it.
 * @returns Whether it was put in place: `false` only if `exclusive` and the lock already exists
 * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if `exclusive` and the file system refuses the hard link
 */
async function putLock(lock: string, content: string, exclusive: boolean): Promise<boolean> {
  const staged = stagedLockPath(lock);
  let placed = true;
  try {
    await writeDurably(staged, content);
    if (exclusive) {
      await linkLock(staged, lock);
    } else {
      await fs.promises.rename(staged, lock);
    }
  } catch (error) {
    if (!(exclusive && fileSystem.isAlreadyExists(error))) {
      throw error;
    }
    placed = false;
  } finally {
    await fileSystem.removeQuietly(staged);
  }
  return placed;
}

/**
 * Links `staged` to `lock`. `EEXIST` with `staged` linked twice means the link was made: a retried NFS request whose first reply
 * was lost.
 * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the file system refuses the hard link with `EPERM`, `ENOTSUP`, `EOPNOTSUPP`
 * or `ENOSYS`. `EPERM` is how some, such as FAT, say they have none, but it also comes from an immutable or append-only directory
 */
async function linkLock(staged: string, lock: string): Promise<void> {
  try {
    await fs.promises.link(staged, lock);
  } catch (error) {
    if (fileSystem.isAlreadyExists(error) && (await fs.promises.stat(staged)).nlink === 2) {
      return;
    }
    if (fileSystem.hasErrorCode(error, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS')) {
      throw ocflError(
        'UNSUPPORTED_FILESYSTEM',
        `Couldn't hard-link the lock ${lock}: the storage root's file system doesn't support hard links, which locks need, or refused this one.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** The `OBJECT_LOCKED` for an object whose lock is held, with `lockedAt` if the lock can still be read */
async function objectLocked(workspace: string): Promise<OcflError> {
  const lock = lockPath(workspace);
  return ocflError('OBJECT_LOCKED', `A writer holds the object's lock ${lock}, or died holding it.`, { lockedAt: await readLockedAt(lock) });
}

/**
 * Takes the lock of the object `id`, without waiting for a writer that holds it.
 * @param workspace - The object's directory in the workspace of the storage root at `storageRoot`
 * @param objectRootExisted - Recorded in the lock, for recovery
 * @param operation - Recorded in the lock, for whoever finds it unfinished
 * @returns What the lock records
 * @throws {@link OcflError} `OBJECT_LOCKED`, with `lockedAt` if the lock can be read, if the lock is already taken. A lock file that
 * exists refuses, even if it can't be read
 * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the lock can't be hard-linked into place; nothing is left behind
 */
async function takeLock(workspace: string, storageRoot: string, id: string, objectRootExisted: boolean, operation: Operation): Promise<Lock> {
  const lock: Lock = { id, operation, lockedAt: new Date(), objectRootExisted, removing: false };
  if (!(await createLockInWorkspace(workspace, storageRoot, formatLock(lock)))) {
    throw await objectLocked(workspace);
  }
  return lock;
}

/** @returns Whether the lock was created: `false` if it already exists */
async function createLockInWorkspace(workspace: string, storageRoot: string, content: string, attempt = 1): Promise<boolean> {
  try {
    await fs.promises.mkdir(workspace, { recursive: true });
    return await putLock(lockPath(workspace), content, true);
  } catch (error) {
    // Not found: another update's clean-up removed the empty workspace before the lock was created in it
    if (fileSystem.isNotFound(error) && attempt < MAX_LOCK_ATTEMPTS) {
      return createLockInWorkspace(workspace, storageRoot, content, attempt + 1);
    }
    await fileSystem.removeEmptyAncestorsQuietly(workspace, storageRoot);
    throw error;
  }
}

/** Removes the object's lock, and the workspace directories that leaves empty */
async function releaseLock(workspace: string, storageRoot: string): Promise<void> {
  await fs.promises.rm(lockPath(workspace), { force: true });
  await fileSystem.removeEmptyAncestorsQuietly(workspace, storageRoot);
}

/**
 * Records in `held`, the object's lock that the caller took, that the object root is about to be deleted.
 * The lock is replaced whole, so it doesn't say so until this returns.
 */
async function markRemoving(workspace: string, held: Lock): Promise<void> {
  await putLock(lockPath(workspace), formatLock({ ...held, removing: true }), false);
}

/** Whether `name`, in an object's directory in the workspace, is a lock's content that was staged and never put in place */
function isStagedLock(name: string): boolean {
  return name.startsWith(STAGED_LOCK_PREFIX);
}

/**
 * The `RECOVERY_NEEDED` for a writer that ended holding the object's lock.
 * @param outcome - What became of it, as a sentence without its full stop
 * @param advice - What recovering the object does, or what to do next, continuing "recover its unfinished write, "
 * @param cause - What the writer failed with
 */
function lockKept(outcome: string, advice: string, cause: unknown): OcflError {
  return ocflError(
    'RECOVERY_NEEDED',
    `${outcome}. The object stays locked until it is recovered: once no writer of it is alive, recover its unfinished write, ${advice}.`,
    { cause },
  );
}

/** Whether the object's lock is held */
async function isLocked(workspace: string): Promise<boolean> {
  return fileSystem.pathExists(lockPath(workspace));
}

export type { Lock };
export { isLocked, isStagedLock, LOCK_NAME, lockKept, markRemoving, objectLocked, readLock, readLockFile, releaseLock, sameWriter, stagedLockPath, takeLock };
