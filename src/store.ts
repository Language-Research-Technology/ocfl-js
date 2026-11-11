import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { hasErrorCode } from './utils.ts';

interface ListedFile {
  /** Relative to the listed directory */
  path: string;
  size: number;
  lastModified: Date;
}

const MAX_PENDING_STATS = 32;

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

/** Keeps a promise that is awaited later from being an unhandled rejection until then */
function rejectLater<T>(promise: Promise<T>) {
  promise.catch(() => {});
  return promise;
}

/** List every file under `dirPath`, in no particular order */
export async function* listFiles(dirPath: string): AsyncGenerator<ListedFile> {
  const buffer: Promise<ListedFile>[] = [];
  const dirQueue = [fs.promises.opendir(dirPath)];
  try {
    for (let dirp = dirQueue.shift(); dirp; dirp = dirQueue.shift()) {
      const dir = await dirp;
      for await (const de of dir) {
        const cdp = path.join(dir.path, de.name);
        if (de.isDirectory()) {
          dirQueue.push(rejectLater(fs.promises.opendir(cdp)));
        } else {
          const f = fs.promises.stat(cdp).then((stats) => ({
            path: path.relative(dirPath, cdp),
            size: stats.size,
            lastModified: stats.mtime,
          }));
          buffer.push(rejectLater(f));
          if (buffer.length > MAX_PENDING_STATS) {
            // biome-ignore lint/style/noNonNullAssertion: an item was just pushed
            yield buffer.shift()!;
          }
        }
      }
    }
    yield* buffer;
  } finally {
    await Promise.allSettled(dirQueue.map(async (dirp) => (await dirp).close()));
  }
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
    if (hasErrorCode(error, 'ENOENT')) {
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

/** {@link removeEmptyAncestors} where a failure must not mask the caller's outcome: a leftover empty directory is harmless */
export async function removeEmptyAncestorsQuietly(dirPath: string, stopAt: string): Promise<void> {
  await removeEmptyAncestors(dirPath, stopAt).catch(() => {});
}
