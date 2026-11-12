import path from 'node:path';
import { ocflError } from './error.ts';
import { type Lock, readLock, sameWriter, updateInProgress } from './lock.ts';
import { recoverObject } from './recover.ts';
import { deepFreeze } from './utils.ts';
import { locksBelow, objectWorkspace, workspaceRoot } from './workspace.ts';

/**
 * A create, update or remove of an object whose lock is still held: its writer is still working, or died. The library can't tell which.
 * Got from {@link StorageRoot.unfinishedWrites} or {@link StorageRoot.unfinishedWrite}, it is the write as its lock recorded it then.
 */
interface UnfinishedWrite {
  /** The id of the object being created, updated or removed. */
  readonly id: string;
  /** When its writer took the object's lock, by that writer's clock. */
  readonly lockedAt: Date;
  /** Whether its writer had begun deleting the object. Recovering it then deletes the rest of the object. */
  readonly removing: boolean;

  /**
   * Clears what the write left behind and releases the object's lock. Does nothing if the lock has been released since.
   *
   * **Only call this when its writer is no longer alive: a live writer's update is destroyed**, and the library can't tell
   * a live writer from a dead one. `lockedAt` says when the lock was taken.
   *
   * A remove that had begun deleting the object is finished. An update that wasn't committed is discarded: its unfinished version in the workspace, the directory of the version after the head
   * in the object, and staged inventory files are removed. A create that wasn't committed is discarded: the declaration and first version of an object that never
   * got an inventory, and its directory if the create made it. An update that was committed is completed by writing the root inventory's sidecar.
   * A version is never made the head, and no other version directory is ever removed. If the write's directory holds another id's object, or is inside
   * another object, its writer was refused before it wrote anything there: only the lock and what is left in the workspace are removed.
   *
   * After `RECOVERY_NEEDED`, recover the write and then open the object again before retrying: the head shows whether the update was committed.
   *
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if another writer has taken the object's lock since; `lockedAt` says when. Nothing is changed.
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's inventory is corrupt or inconsistent, or it has a declaration and no inventory and a version other than the first, which a dead create never leaves. Nothing is changed.
   * @throws The file system error that stopped it; the object stays locked, and the write can be recovered again.
   * @example
   * ```ts
   * try {
   *   object = await object.update(details, change);
   * } catch (error) {
   *   if ((error as OcflError).code !== 'RECOVERY_NEEDED') throw error;
   *   // This process is the only writer, so none is alive
   *   await (await root.unfinishedWrite(object.id))?.recover();
   *   object = await root.open(object.id);
   * }
   * ```
   */
  recover(): Promise<void>;
}

/** @param seen - The lock as it was when the write was found */
function unfinishedWrite(storageRoot: string, objectRoot: string, seen: Lock): UnfinishedWrite {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  return deepFreeze({
    id: seen.id,
    lockedAt: new Date(seen.lockedAt),
    removing: seen.removing,
    async recover() {
      const lock = await readLock(workspace);
      if (lock === undefined) {
        return;
      }
      if (!sameWriter(lock, seen)) {
        throw await updateInProgress(workspace);
      }
      await recoverObject(storageRoot, objectRoot, lock);
    },
  });
}

/**
 * The unfinished write of `id`, whose object the storage root's layout places at `objectRoot`, or `undefined` if it isn't locked.
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the lock there is a writer's of another id
 */
async function findUnfinishedWrite(storageRoot: string, objectRoot: string, id: string): Promise<UnfinishedWrite | undefined> {
  const lock = await readLock(objectWorkspace(storageRoot, objectRoot));
  if (lock === undefined) {
    return undefined;
  }
  if (lock.id !== id) {
    throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `${objectRoot}, where the storage root places <${id}>, is locked by a writer of <${lock.id}>.`);
  }
  return unfinishedWrite(storageRoot, objectRoot, lock);
}

/**
 * Every unfinished write in the storage root, found by the locks in its workspace.
 * A file named as a lock counts only if it holds a lock, and sits where the layout places its id's directory in the workspace.
 * @param objectPathOf - The object root of an id, relative to the storage root; throws if the layout can't place it
 */
async function* listUnfinishedWrites(storageRoot: string, objectPathOf: (id: string) => string): AsyncGenerator<UnfinishedWrite> {
  const workspace = workspaceRoot(storageRoot);
  for await (const { dir, lock } of locksBelow(workspace)) {
    const objectPath = path.relative(workspace, dir);
    if (placedAt(objectPathOf, lock.id) === objectPath) {
      yield unfinishedWrite(storageRoot, path.join(storageRoot, objectPath), lock);
    }
  }
}

function placedAt(objectPathOf: (id: string) => string, id: string): string | undefined {
  try {
    return objectPathOf(id);
  } catch {
    return undefined;
  }
}

export type { UnfinishedWrite };
export { findUnfinishedWrite, listUnfinishedWrites };
