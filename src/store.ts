import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { hasErrorCode } from './utils.ts';

async function createParents(filePath: string) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export function createReadable(filePath: string, options?: unknown): ReadableStream {
  return Readable.toWeb(fs.createReadStream(filePath, options as Parameters<typeof fs.createReadStream>[1])) as ReadableStream;
}

/** A string is written as UTF-8 */
export async function writeFile(filePath: string, data: string | Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
  await createParents(filePath);
  await fs.promises.writeFile(filePath, data);
}

export async function copyFile(source: string, target: string): Promise<void> {
  await createParents(target);
  await fs.promises.copyFile(source, target);
}

export async function move(source: string, target: string): Promise<void> {
  await createParents(target);
  await fs.promises.rename(source, target);
}

/**
 * A missing directory is not an error
 * @returns Whether the directory is gone
 */
export async function removeIfEmpty(dirPath: string): Promise<boolean> {
  try {
    await fs.promises.rmdir(dirPath);
    return true;
  } catch (error) {
    // ENAMETOOLONG: nothing can be at a path with a name that long
    if (hasErrorCode(error, 'ENOENT', 'ENAMETOOLONG')) {
      return true;
    }
    // POSIX allows EEXIST in place of ENOTEMPTY
    if (hasErrorCode(error, 'ENOTEMPTY', 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

/** Remove `dirPath` and then each parent while it is empty, stopping below `stopAt` */
export async function removeEmptyAncestors(dirPath: string, stopAt: string): Promise<void> {
  for (let dir = dirPath; dir.startsWith(stopAt + path.sep); dir = path.dirname(dir)) {
    if (!(await removeIfEmpty(dir))) {
      return;
    }
  }
}

/** Remove a file or directory, recursively, where a failure must not mask the caller's */
export async function removeQuietly(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { recursive: true, force: true }).catch(() => {});
}

/** {@link removeEmptyAncestors} where a failure must not mask the caller's outcome: a leftover empty directory is harmless */
export async function removeEmptyAncestorsQuietly(dirPath: string, stopAt: string): Promise<void> {
  await removeEmptyAncestors(dirPath, stopAt).catch(() => {});
}
