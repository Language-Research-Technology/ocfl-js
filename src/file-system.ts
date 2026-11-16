import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return isErrnoException(error) && codes.includes(error.code as string);
}

export function isAlreadyExists(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'EEXIST';
}

export function isNotFound(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

export function isNotDir(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOTDIR';
}

/** Whether nothing can be at the path read: it doesn't exist, a directory above it is a file, or a name in it is too long */
export function isNothingAtPath(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG');
}

/** The most UTF-8 bytes common file systems allow in one file or directory name */
export const MAX_NAME_BYTES = 255;

/** Whether a segment of the path `p` is too long for a file system to name */
export function hasOverlongSegment(p: string): boolean {
  return p.split('/').some((segment) => Buffer.byteLength(segment) > MAX_NAME_BYTES);
}

/** Whether `file` is short enough for the file system to look it up, whether or not anything is there */
export async function pathFits(file: string): Promise<boolean> {
  const found: unknown = await fs.promises.lstat(file).catch((error: unknown) => error);
  return !hasErrorCode(found, 'ENAMETOOLONG');
}

/** `target`, resolved against `root`, relative to `root`: `''` for `root` itself, or `undefined` if it's outside `root` */
export function relativeWithin(root: string, target: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/** `target`'s path from `storageRoot`, with `/` between directories on every platform, as the public API gives it */
export function pathFromStorageRoot(storageRoot: string, target: string): string {
  return path.relative(storageRoot, target).split(path.sep).join('/');
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error) || isNotDir(error)) {
      return false;
    }
    throw error;
  }
}

/** The file's text, or `undefined` if it doesn't exist */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** What tells one state of a file from another: a replacement changes the inode, a rewrite in place the size or modification time */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

function identityFrom({ dev, ino, size, mtimeNs }: fs.BigIntStats): FileIdentity {
  return { dev, ino, size, mtimeNs };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export async function identityOf(file: string): Promise<FileIdentity> {
  return identityFrom(await fs.promises.stat(file, { bigint: true }));
}

/**
 * The file's text, with the identity of the file it was read from, noted before reading so that a rewrite during the read changes it
 * @returns `undefined` if nothing can be at its path
 */
export async function readWithIdentity(file: string): Promise<{ text: string; identity: FileIdentity } | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (error) {
    if (isNothingAtPath(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const identity = identityFrom(await handle.stat({ bigint: true }));
    return { text: await handle.readFile('utf8'), identity };
  } finally {
    await handle.close();
  }
}

/** What is at `dirPath`: nothing or an empty directory, a file or a directory with something in it, or nothing because a parent is a file */
export type DirContents = 'empty' | 'not empty' | 'a file' | 'below a file';

export async function dirContents(dirPath: string): Promise<DirContents> {
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(dirPath);
  } catch (error) {
    if (isNotFound(error)) {
      return 'empty';
    }
    // ENOTDIR: either the path is a file, or one of its parents is and the path doesn't exist
    if (isNotDir(error)) {
      return (await pathExists(dirPath)) ? 'a file' : 'below a file';
    }
    throw error;
  }
  try {
    return (await dir.read()) ? 'not empty' : 'empty';
  } finally {
    // A failed close of a directory only read must not mask the result; it can't be made to fail
    /* node:coverage ignore next */
    await dir.close().catch(() => {});
  }
}

export async function isDirEmpty(dirPath: string): Promise<boolean> {
  const contents = await dirContents(dirPath);
  return contents === 'empty' || contents === 'below a file';
}

async function createParents(filePath: string) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

/** Runs `consume` on a stream of the file's bytes, which `signal` aborts, and settles only once the file is closed */
export async function withReadStream<T>(filePath: string, signal: AbortSignal | undefined, consume: (bytes: AsyncIterable<Buffer>) => Promise<T>): Promise<T> {
  const stream = fs.createReadStream(filePath, signal && { signal });
  try {
    return await consume(stream);
  } finally {
    await new Promise<void>((resolve) => stream.close(() => resolve()));
  }
}

export function createReadable(filePath: string): ReadableStream {
  return Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
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
    // ENAMETOOLONG: nothing can be at that path, such as the directory of a draft's file
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
