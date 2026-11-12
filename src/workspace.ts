import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { isVersionName } from './inventory.ts';
import { isStagedLock, LOCK_NAME, type Lock, readLockFile } from './lock.ts';
import { isNothingAtPath } from './utils.ts';

const { EXTENSIONS_DIR, WORKSPACE_EXTENSION } = OcflConstants;

/** The workspace of the storage root at the absolute path `root` */
function workspaceRoot(root: string): string {
  return path.join(root, EXTENSIONS_DIR, WORKSPACE_EXTENSION);
}

/**
 * The directory, in the workspace of the storage root at the absolute path `root`, of the object at `objectRoot`
 * @param objectRoot - Absolute, and inside the storage root
 */
function objectWorkspace(root: string, objectRoot: string): string {
  return path.join(workspaceRoot(root), path.relative(root, objectRoot));
}

/** What `list` gives for a directory, or nothing if nothing can be at its path */
async function listed<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch (error) {
    if (isNothingAtPath(error)) {
      return [];
    }
    throw error;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  return listed(() => fs.promises.readdir(dir));
}

async function removeAll(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Every lock at or below `dir`, with the directory holding it, as each is found. A directory holding a lock isn't searched further:
 * no layout nests object roots, so nothing below it is another object's directory in the workspace.
 */
async function* locksBelow(dir: string): AsyncGenerator<{ dir: string; lock: Lock }> {
  const entries = await listed(() => fs.promises.readdir(dir, { withFileTypes: true }));
  const lock = entries.some((entry) => entry.name === LOCK_NAME && entry.isFile()) ? await readLockFile(path.join(dir, LOCK_NAME)) : undefined;
  if (lock) {
    yield { dir, lock };
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      yield* locksBelow(path.join(dir, entry.name));
    }
  }
}

/** Whether a lock is held anywhere below `dir` */
async function holdsLock(dir: string): Promise<boolean> {
  return !(await locksBelow(dir).next()).done;
}

/**
 * The unfinished versions among `names`, the entries of an object's directory in the workspace.
 * A storage root an earlier release or another tool wrote can hold another object's directory in the workspace at or below a version's name, where a live writer of it holds its lock.
 */
async function unfinishedVersions(workspace: string, names: string[]): Promise<string[]> {
  const versions = names.filter(isVersionName);
  const foreign = await Promise.all(versions.map((name) => holdsLock(path.join(workspace, name))));
  return versions.filter((_name, i) => !foreign[i]);
}

/**
 * Removes, from an object's directory `workspace` in the workspace, its unfinished versions and staged lock content.
 * Only for a caller holding the object's lock, so no live writer is assembling a version there. A writer staging a lock meanwhile
 * fails to put it in place, and tries again.
 */
async function clearWorkspace(workspace: string): Promise<void> {
  const names = await namesIn(workspace);
  await removeAll(workspace, [...(await unfinishedVersions(workspace, names)), ...names.filter(isStagedLock)]);
}

export { clearWorkspace, locksBelow, namesIn, objectWorkspace, removeAll, workspaceRoot };
