import path from 'node:path';
import { type OcflError, ocflError } from './error.ts';

/** The form a logical path takes on disk, so two spellings of one path are the same path */
export function normaliseLogicalPath(logicalPath: string): string {
  return path.posix.normalize(logicalPath).replace(/\/$/, '');
}

/** The directories a logical path is inside, outermost first */
export function parentDirectories(logicalPath: string): string[] {
  const directories: string[] = [];
  for (let end = logicalPath.indexOf('/'); end !== -1; end = logicalPath.indexOf('/', end + 1)) {
    directories.push(logicalPath.slice(0, end));
  }
  return directories;
}

/** For `logicalPath`, given for the object `objectId`, which is absolute or has a `..` segment */
export function invalidLogicalPath(logicalPath: string, objectId: string): OcflError {
  return ocflError('INVALID_LOGICAL_PATH', `Logical path "${logicalPath}" in the object <${objectId}> must be a relative path without \`..\``, {
    objectId,
    logicalPath,
  });
}

// Backslash counts as a separator because path.normalize treats it as one on Windows
export function checkLogicalPath(logicalPath: string, objectId: string): void {
  if (logicalPath.startsWith('/') || path.isAbsolute(logicalPath) || logicalPath.split(/[/\\]/).includes('..')) {
    throw invalidLogicalPath(logicalPath, objectId);
  }
}

/**
 * `logicalPath`, given for the object `objectId`, normalised so two spellings of one path are the same path
 * @throws {@link OcflError} `INVALID_LOGICAL_PATH` with `emptyMessage` if it names the object root
 */
export function nonEmptyLogicalPath(logicalPath: string, objectId: string, emptyMessage: string): string {
  checkLogicalPath(logicalPath, objectId);
  const normalised = normaliseLogicalPath(logicalPath);
  if (normalised === '.') {
    throw ocflError('INVALID_LOGICAL_PATH', emptyMessage, { objectId });
  }
  return normalised;
}

/** A file's logical path, given for the object `objectId`, in the form the inventory lists */
export function fileLogicalPath(logicalPath: string, objectId: string): string {
  return nonEmptyLogicalPath(logicalPath, objectId, `A file's logical path in the object <${objectId}> can't be empty`);
}
