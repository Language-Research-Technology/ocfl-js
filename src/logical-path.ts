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

export function invalidLogicalPath(logicalPath: string): OcflError {
  return ocflError('INVALID_LOGICAL_PATH', `Logical path "${logicalPath}" must be a relative path without \`..\``);
}

// Backslash counts as a separator because path.normalize treats it as one on Windows
export function checkLogicalPath(logicalPath: string): void {
  if (logicalPath.startsWith('/') || path.isAbsolute(logicalPath) || logicalPath.split(/[/\\]/).includes('..')) {
    throw invalidLogicalPath(logicalPath);
  }
}

/** A file's logical path in the form the inventory lists, so two spellings of one path are the same path */
export function fileLogicalPath(logicalPath: string): string {
  checkLogicalPath(logicalPath);
  const normalised = normaliseLogicalPath(logicalPath);
  if (normalised === '.') {
    throw ocflError('INVALID_LOGICAL_PATH', "A file's logical path can't be empty");
  }
  return normalised;
}
