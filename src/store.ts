import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { WriteFileData } from './types.ts';
import { isErrnoException } from './utils.ts';

interface ListedFile {
  /** Relative to the listed directory */
  path: string;
  size: number;
  lastModified: Date;
}

const MAX_PENDING_STATS = 32;

function hasErrorCode(error: unknown, ...codes: string[]) {
  return isErrnoException(error) && codes.includes(error.code as string);
}

async function createParents(filePath: string) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export function createReadable(filePath: string, options?: unknown): ReadableStream {
  return Readable.toWeb(fs.createReadStream(filePath, options as Parameters<typeof fs.createReadStream>[1])) as ReadableStream;
}

export async function createWritable(filePath: string, options?: unknown): Promise<WritableStream> {
  await createParents(filePath);
  return Writable.toWeb(fs.createWriteStream(filePath, options as Parameters<typeof fs.createWriteStream>[1]));
}

export async function writeFile(filePath: string, data: WriteFileData, options?: object | string): Promise<void> {
  await createParents(filePath);
  // Readable.from, not fromWeb: fromWeb reads eagerly, so a source failure before writeFile attaches would be uncaught
  const content = data instanceof ReadableStream ? Readable.from(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  await fs.promises.writeFile(filePath, content, options as Parameters<typeof fs.promises.writeFile>[2]);
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
  try {
    await fs.promises.rename(source, target);
    return;
  } catch (error) {
    if (!hasErrorCode(error, 'EXDEV')) {
      throw error;
    }
  }
  // Stage on the target's filesystem so the final step is an atomic rename.
  const staging = await fs.promises.mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-`));
  try {
    const staged = path.join(staging, path.basename(target));
    await fs.promises.cp(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.promises.rename(staged, target);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  // The target is complete, so a leftover source must not fail the move
  await fs.promises.rm(source, { recursive: true, force: true }).catch(() => {});
}

/** A missing directory is not an error */
export async function removeIfEmpty(dirPath: string): Promise<void> {
  try {
    await fs.promises.rmdir(dirPath);
  } catch (error) {
    // POSIX allows EEXIST in place of ENOTEMPTY
    if (!hasErrorCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST')) {
      throw error;
    }
  }
}
