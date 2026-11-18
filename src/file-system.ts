import fs from 'node:fs';
import path from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createLimiter } from './utils.ts';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return isErrnoException(error) && codes.includes(error.code as string);
}

export function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

export function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function isNotDir(error: unknown): boolean {
  return hasErrorCode(error, 'ENOTDIR');
}

/** Whether nothing can be at the path read: it doesn't exist, a directory above it is a file, or a name in it is too long */
export function isNothingAtPath(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG');
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

/** The names in `dir`, or none if nothing can be at its path */
export async function namesIn(dir: string): Promise<string[]> {
  return listed(() => fs.promises.readdir(dir));
}

/** The entries in `dir`, or none if nothing can be at its path */
export async function entriesIn(dir: string): Promise<fs.Dirent[]> {
  return listed(() => fs.promises.readdir(dir, { withFileTypes: true }));
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

/**
 * The file's text, or `undefined` if nothing can be at its path. For a probe where a parent that is a file, or a name too long,
 * means only that the file isn't there; where that would hide a fault, use {@link readIfExists}.
 */
export async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isNothingAtPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The file's text, or `undefined` if it doesn't exist. A parent that is a file, or a name too long, is thrown: for a file whose
 * absence has a meaning, such as a layout config that gives the default parameters, so a damaged directory isn't read as absent.
 */
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

interface OpenFile {
  readonly handle: fs.promises.FileHandle;
  readonly size: number;
}

/** Why there is no regular file at a path, with the error that said so, if any */
interface AbsentFile {
  readonly absent: 'missing' | 'not a file';
  readonly cause?: unknown;
}

/** Opens the regular file at `filePath` for reading, without waiting on a named pipe */
export async function openRegularFile(filePath: string): Promise<OpenFile | AbsentFile> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (isNothingAtPath(error)) {
      return { absent: 'missing', cause: error };
    }
    // Opening a socket
    if (hasErrorCode(error, 'ENXIO')) {
      return { absent: 'not a file', cause: error };
    }
    throw error;
  }
  let isFile = false;
  try {
    const stats = await handle.stat();
    isFile = stats.isFile();
    return isFile ? { handle, size: stats.size } : { absent: 'not a file' };
  } finally {
    if (!isFile) {
      await handle.close();
    }
  }
}

/** Runs `consume` on a stream of the open file's bytes, which `signal` aborts, and settles only once the file is closed */
export async function withReadStream<T>(
  handle: fs.promises.FileHandle,
  signal: AbortSignal | undefined,
  consume: (bytes: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  const stream = handle.createReadStream({ signal });
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

/**
 * Writes what `open` gives to a new file at `filePath`, with its times set to `time` through the file's own handle, never through a path that could be swapped for a link.
 * Opens the source only once the parents exist, so no source is left open if they can't be made.
 * @throws `signal.reason` if `signal` is aborted while writing; the source and the new file are closed
 */
export async function writeFileFrom(filePath: string, open: () => Promise<Readable>, time: Date, signal: AbortSignal | undefined): Promise<void> {
  await createParents(filePath);
  const source = await open();
  if (signal) {
    // Destroys the source on abort, so a read that has stalled doesn't hold the write until its next chunk
    addAbortSignal(signal, source);
  }
  try {
    const handle = await fs.promises.open(filePath, 'wx');
    try {
      await handle.writeFile(source, { signal });
      await handle.utimes(time, time);
    } finally {
      await handle.close();
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    source.destroy();
    // Its error is the one caught above, or a premature close from destroying it
    await finished(source).catch(() => undefined);
  }
}

export async function copyFile(source: string, target: string): Promise<void> {
  await createParents(target);
  await fs.promises.copyFile(source, target);
}

/** Flushes the file or directory at `target` to disk: its data, or for a directory the names in it */
async function flush(target: string): Promise<void> {
  const handle = await fs.promises.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** `dir` and each directory above it, up to and including `top` */
export function directoriesUpTo(dir: string, top: string): string[] {
  const directories = [];
  for (let current = dir; current !== top; current = path.dirname(current)) {
    directories.push(current);
  }
  directories.push(top);
  return directories;
}

/** `dir`, or else the nearest directory above it that exists, stopping at `top` */
export async function nearestExisting(dir: string, top: string): Promise<string> {
  let current = dir;
  while (current !== top && !(await pathExists(current))) {
    current = path.dirname(current);
  }
  return current;
}

const FLUSH_CONCURRENCY = 10;

/** Flushes each of `targets`, at most {@link FLUSH_CONCURRENCY} at once; settles only once every flush has, throwing the first failure */
async function flushAll(targets: readonly string[]): Promise<void> {
  const limit = createLimiter(FLUSH_CONCURRENCY);
  const flushes = await Promise.allSettled(targets.map((target) => limit(() => flush(target))));
  const failed = flushes.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}

/** Flushes files and directories to disk, or does nothing, as a storage root's durability says */
export interface Flusher {
  /** Flushes each of `targets`, in no particular order */
  flush(...targets: string[]): Promise<void>;
  /** Flushes `dir`, and every file and directory below it */
  flushTree(dir: string): Promise<void>;
}

export const FLUSHING: Flusher = {
  flush: (...targets) => flushAll(targets),
  async flushTree(dir) {
    const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
    await flushAll([dir, ...entries.map((entry) => path.join(entry.parentPath, entry.name))]);
  },
};

export const NOT_FLUSHING: Flusher = {
  flush: async () => {},
  flushTree: async () => {},
};

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
