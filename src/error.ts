import type { ValidationErrorCode } from './validation.ts';

/** Every value of {@link OcflError.code}. */
type OcflErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_EXISTS'
  | 'OBJECT_OUT_OF_DATE'
  | 'INVALID_OBJECT'
  | 'INVALID_STORAGE_ROOT'
  | 'OBJECT_NOT_LOADED'
  | 'NOT_AN_OBJECT'
  | 'UPDATE_IN_PROGRESS'
  | 'RECOVERY_NEEDED'
  | 'DIRECTORY_NOT_EMPTY'
  | 'ID_INCOMPATIBLE_WITH_LAYOUT'
  | 'INVALID_LOGICAL_PATH'
  | 'INVALID_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'UNSUPPORTED_LAYOUT'
  | 'INVALID_LAYOUT_CONFIG'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'SOURCE_CHANGED'
  | 'MUTABLE_HEAD_ACTIVE'
  | 'CROSS_FILESYSTEM_MOVE'
  | 'VERSION_LIMIT_REACHED'
  | ValidationErrorCode;

/** Base class for errors a client can handle by their `code`. The message isn't part of the contract. */
class OcflError extends Error {
  /** What went wrong. */
  readonly code: OcflErrorCode;
  /** The OCFL validation code, such as `E060`, when the fault has one. */
  declare readonly ocflCode?: string;
  /** When the object's lock was taken. Set only for `UPDATE_IN_PROGRESS`, and absent when the lock couldn't be read or was released meanwhile. */
  declare readonly lockedAt?: Date;

  /**
   * Makes an error; an option left out or `undefined` leaves its field absent.
   *
   * @param code - What went wrong
   * @param message - Human-readable description; not part of the contract
   * @param options - `ocflCode` and `lockedAt` as on the error; `cause` is the error being wrapped
   */
  constructor(code: OcflErrorCode, message: string, options: { ocflCode?: string | undefined; lockedAt?: Date | undefined; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OcflError';
    this.code = code;
    if (options.ocflCode !== undefined) {
      this.ocflCode = options.ocflCode;
    }
    if (options.lockedAt !== undefined) {
      this.lockedAt = options.lockedAt;
    }
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
