import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { OcflConstants, type OcflVersion } from './constants.ts';

const { OCFL_VERSIONS, NAMASTE_T } = OcflConstants;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return isErrnoException(error) && codes.includes(error.code as string);
}

function isAlreadyExists(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

/** Whether nothing can be at the path read: it doesn't exist, a directory above it is a file, or a name in it is too long */
function isNothingAtPath(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG');
}

function isNotDir(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOTDIR';
}

/** `target`, resolved against `root`, relative to `root`: `''` for `root` itself, or `undefined` if it's outside `root` */
function relativeWithin(root: string, target: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/** The file's text, or `undefined` if it doesn't exist */
async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The form a logical path takes on disk, so two spellings of one path are the same path */
function normaliseLogicalPath(logicalPath: string): string {
  return path.posix.normalize(logicalPath).replace(/\/$/, '');
}

/** The most UTF-8 bytes common file systems allow in one file or directory name */
const MAX_NAME_BYTES = 255;

/** Whether a segment of the path `p` is too long for a file system to name */
function hasOverlongSegment(p: string): boolean {
  return p.split('/').some((segment) => Buffer.byteLength(segment) > MAX_NAME_BYTES);
}

/** The directories a logical path is inside, outermost first */
function parentDirectories(logicalPath: string): string[] {
  const directories: string[] = [];
  for (let end = logicalPath.indexOf('/'); end !== -1; end = logicalPath.indexOf('/', end + 1)) {
    directories.push(logicalPath.slice(0, end));
  }
  return directories;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** `content` parsed as a JSON object, or `undefined` if it isn't one */
function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch (_error) {
    return undefined;
  }
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** @returns a function that runs the functions given to it, at most `count` at once */
function createLimiter(count: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active < count) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/** What is at `dirPath`: nothing or an empty directory, a file or a directory with something in it, or nothing because a parent is a file */
async function dirContents(dirPath: string): Promise<'empty' | 'not empty' | 'below a file'> {
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(dirPath);
  } catch (error) {
    if (isNotFound(error)) {
      return 'empty';
    }
    // ENOTDIR: either the path is a file, or one of its parents is and the path doesn't exist
    if (isNotDir(error)) {
      return (await pathExists(dirPath)) ? 'not empty' : 'below a file';
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

async function isDirEmpty(dirPath: string): Promise<boolean> {
  return (await dirContents(dirPath)) !== 'not empty';
}

async function pathExists(filePath: string): Promise<boolean> {
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
 * Check if there is any valid namaste in the rootPath and return the version number.
 * @returns The version, `''` if a namaste exists but is invalid, or `undefined` if there is none.
 */
async function findNamasteVersion(prefix: string, rootPath: string): Promise<OcflVersion | '' | undefined> {
  const namastePath = `${rootPath}/${NAMASTE_T}${prefix}`;
  try {
    const version = await Promise.any(OCFL_VERSIONS.map(async (v) => ((await fs.promises.readFile(namastePath + v, 'utf8')) === `${prefix}${v}\n` ? v : null)));
    return version ?? '';
  } catch (error) {
    // ENOTDIR: the root is a file, which can't hold a declaration
    const failure = (error as AggregateError).errors.find((e) => !isNotFound(e) && !isNotDir(e));
    if (failure) {
      throw failure;
    }
    return undefined;
  }
}

/** `value`, with it and everything nested in it frozen */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param refusal - Starts the message, e.g. `createStorageRoot has no option`
 * @throws `TypeError` naming each key of `object` that `isKnown` refuses
 */
function rejectUnknownKeys(object: object, isKnown: (key: string) => boolean, refusal: string): void {
  const unknown = Object.keys(object).filter((key) => !isKnown(key));
  if (unknown.length > 0) {
    throw new TypeError(`${refusal} ${unknown.map((key) => inspect(key)).join(' or ')}.`);
  }
}

export {
  createLimiter,
  deepFreeze,
  dirContents,
  findNamasteVersion,
  hasErrorCode,
  hasOverlongSegment,
  isAlreadyExists,
  isDirEmpty,
  isErrnoException,
  isNonEmptyString,
  isNotFound,
  isNothingAtPath,
  MAX_NAME_BYTES,
  normaliseLogicalPath,
  parentDirectories,
  parseJsonObject,
  pathExists,
  readIfExists,
  rejectUnknownKeys,
  relativeWithin,
};
