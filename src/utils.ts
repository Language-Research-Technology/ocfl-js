import fs from 'node:fs';
import { OcflConstants } from './constants.ts';
import type { OcflVersion } from './types.ts';

const { OCFL_VERSIONS, NAMASTE_T } = OcflConstants;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isAlreadyExists(error: unknown) {
  return isErrnoException(error) && error.code === 'EEXIST';
}

function isNotFound(error: unknown) {
  return isErrnoException(error) && error.code === 'ENOENT';
}

/**
 * Run `asyncFn` over every element of `inputStack` with at most `count` calls in flight.
 * Rejections are returned in the result array rather than thrown.
 * @param inputStack - Consumed during the process.
 * @param count - Maximum number of concurrency
 */
async function parallelize<T, R>(inputStack: T[], asyncFn: (input: T) => Promise<R>, count = 10): Promise<(R | Error)[]> {
  const promises: Promise<void>[] = [];
  let len = Math.min(inputStack.length, count);
  const result: (R | Error)[] = [];
  while (len--) {
    promises.push(
      (async () => {
        while (inputStack.length) {
          const input = inputStack.pop() as T;
          const index = inputStack.length;
          try {
            result[index] = await asyncFn(input);
          } catch (error) {
            result[index] = error instanceof Error ? error : new Error(String(error), { cause: error });
          }
        }
      })().catch(() => {}),
    );
  }
  await Promise.all(promises);
  return result;
}

async function isDirEmpty(dirPath: string): Promise<boolean> {
  let de: unknown;
  try {
    const dir = await fs.promises.opendir(dirPath);
    de = await dir.read();
    await dir.close();
  } catch (error) {
    return isNotFound(error);
  }
  return !de;
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

export { findNamasteVersion, isAlreadyExists, isDirEmpty, isErrnoException, isNotFound, parallelize };
