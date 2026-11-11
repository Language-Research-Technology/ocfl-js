/** Every value of {@link OcflError.code}. */
type OcflErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_EXISTS'
  | 'OBJECT_OUT_OF_DATE'
  | 'INVALID_OBJECT'
  | 'INVALID_STORAGE_ROOT'
  | 'UNSUPPORTED_LAYOUT'
  | 'ID_INCOMPATIBLE_WITH_LAYOUT'
  | 'DIRECTORY_NOT_EMPTY'
  | 'UPDATE_IN_PROGRESS'
  | 'RECOVERY_NEEDED'
  | 'MUTABLE_HEAD_ACTIVE'
  | 'CROSS_FILESYSTEM_MOVE'
  | 'VERSION_LIMIT_REACHED'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'INVALID_LOGICAL_PATH'
  | 'SOURCE_CHANGED'
  | 'UNSUPPORTED_FILE_TYPE';

interface OcflErrorOptions {
  ocflCode?: string | undefined;
  lockedAt?: Date | undefined;
  /** The error being wrapped */
  cause?: unknown;
}

/**
 * The error the library throws for anything a caller might handle; test `code`. The message isn't part of the contract.
 * Misuse throws a plain `TypeError` or `Error`, and file system errors such as `ENOSPC` pass through untouched.
 */
class OcflError extends Error {
  /** What went wrong. */
  readonly code: OcflErrorCode;
  /** The OCFL validation code, such as `E060`, when the fault has one. */
  declare readonly ocflCode?: string;
  /** When the object's lock was taken. Set only for `UPDATE_IN_PROGRESS`, and absent when the lock couldn't be read or was released meanwhile. */
  declare readonly lockedAt?: Date;

  /**
   * Makes an error; an option left out or `undefined` leaves its field absent.
   * @internal
   */
  static _create(code: OcflErrorCode, message: string, options?: OcflErrorOptions): OcflError {
    return new OcflError(code, message, options);
  }

  private constructor(code: OcflErrorCode, message: string, options: OcflErrorOptions = {}) {
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

const ocflError: (code: OcflErrorCode, message: string, options?: OcflErrorOptions) => OcflError = OcflError._create;

export { OcflError, type OcflErrorCode, ocflError };
