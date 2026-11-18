import path from 'node:path';
import { OCFL_CONSTANTS } from './constants.ts';
import { stagedLockPath } from './lock.ts';
import { workspaceRoot } from './workspace.ts';

/** Where an object is, or would be */
export interface ObjectPlace {
  /** Absolute path of the storage root, where removing empty directories stops */
  readonly storageRoot: string;
  /** Absolute path of the object root, inside the storage root */
  readonly objectRoot: string;
  /** The object's directory in the storage root's workspace, which holds its lock */
  readonly workspace: string;
}

/**
 * The place of the object at `objectRoot`, in the storage root at the absolute path `storageRoot`
 * @param objectRoot - Absolute, and inside the storage root
 */
export function objectPlace(storageRoot: string, objectRoot: string): ObjectPlace {
  return { storageRoot, objectRoot, workspace: path.join(workspaceRoot(storageRoot), path.relative(storageRoot, objectRoot)) };
}

/**
 * The longest path a writer of the object at `place` uses, whatever the object holds: the content staged beside its lock.
 * Only paths in the object's content can be longer.
 */
export function longestWriterPath(place: ObjectPlace): string {
  return stagedLockPath(path.join(place.workspace, OCFL_CONSTANTS.LOCK_NAME));
}
