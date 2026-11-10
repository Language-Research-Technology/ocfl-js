import type { ValidationErrorCode } from './validation.ts';

type OcflErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_NOT_LOADED'
  | 'NOT_AN_OBJECT'
  | 'UPDATE_IN_PROGRESS'
  | 'DIRECTORY_NOT_EMPTY'
  | 'ID_INCOMPATIBLE_WITH_LAYOUT'
  | 'INVALID_LOGICAL_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'UNSUPPORTED_LAYOUT'
  | 'LAYOUT_MISMATCH'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'SOURCE_CHANGED'
  | ValidationErrorCode;

/** Base class for errors a client can handle by their `code`. The message isn't part of the contract. */
class OcflError extends Error {
  readonly code: OcflErrorCode;

  constructor(code: OcflErrorCode, message: string) {
    super(message);
    this.name = 'OcflError';
    this.code = code;
  }
}

class ObjectNotLoadedError extends OcflError {
  declare readonly code: 'OBJECT_NOT_LOADED';

  constructor(label: string) {
    super('OBJECT_NOT_LOADED', `OCFL Object "${label}" is not loaded; call load() first`);
    this.name = 'ObjectNotLoadedError';
  }
}

class ObjectNotFoundError extends OcflError {
  declare readonly code: 'OBJECT_NOT_FOUND';

  constructor(label: string) {
    super('OBJECT_NOT_FOUND', `OCFL Object "${label}" does not exist`);
    this.name = 'ObjectNotFoundError';
  }
}

export type { OcflErrorCode };
export { ObjectNotFoundError, ObjectNotLoadedError, OcflError };
