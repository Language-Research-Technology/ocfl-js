import fs from 'node:fs';
import { OcflConstants } from './constants.ts';
import type { OcflVersion } from './types.ts';

const { OCFL_VERSIONS, NAMASTE_T } = OcflConstants;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isAlreadyExists(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
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

async function isDirEmpty(dirPath: string): Promise<boolean> {
  let dir: fs.Dir | undefined;
  try {
    dir = await fs.promises.opendir(dirPath);
    return !(await dir.read());
  } catch (error) {
    return isNotFound(error);
  } finally {
    await dir?.close().catch(() => {});
  }
}

/**
 * Check if there is any valid namaste in the rootPath and return the version number.
 * @returns The version, `''` if a namaste exists but is invalid, or `undefined` if there is none.
 */
async function findNamasteVersion(prefix: string, rootPath: string): Promise<OcflVersion | '' | undefined> {
  const namastePath = `${rootPath}/${NAMASTE_T}${prefix}`;
  let version: OcflVersion | null | undefined;
  try {
    version = await Promise.any(OCFL_VERSIONS.map(async (v) => ((await fs.promises.readFile(namastePath + v, 'utf8')) === `${prefix}${v}\n` ? v : null)));
    if (!version) {
      return '';
    }
  } catch (error) {
    // ENOTDIR: the root is a file, which can't hold a declaration
    if (!(error instanceof AggregateError) || error.errors.some((e) => !isNotFound(e) && !(isErrnoException(e) && e.code === 'ENOTDIR'))) {
      throw error;
    }
  }
  return version ?? undefined;
}

export { createLimiter, findNamasteVersion, isAlreadyExists, isDirEmpty, isErrnoException, isNotFound };
