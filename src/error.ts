/**
 * Every value of {@link OcflError.code}: what causes it, and whether retrying helps. The
 * {@link https://language-research-technology.github.io/ocfl-js/guides/errors/ | errors guide} says more about each.
 * Test one with {@link isOcflError}, which narrows `code` to it:
 * ```ts
 * if (isOcflError(error, 'FILE_NOT_FOUND')) console.log(`Nothing at ${error.logicalPath} in ${error.objectId}`);
 * ```
 *
 * | Code | Cause | Retry? |
 * | --- | --- | --- |
 * | `OBJECT_NOT_FOUND` | No object has this id, or the storage layout can't place one with it. Safe to treat as not found. | No |
 * | `OBJECT_EXISTS` | `create` found an object with this id. Open it instead. | No |
 * | `OBJECT_OUT_OF_DATE` | A version was committed, or the object purged, since it was opened. | After opening it again |
 * | `INVALID_OBJECT` | The object on disk is damaged, or isn't one the library can safely read. | No |
 * | `STORAGE_ROOT_NOT_FOUND` | `openStorageRoot` found nothing at the path, or an empty directory. | No |
 * | `INVALID_STORAGE_ROOT` | `openStorageRoot` found something that isn't a storage root it can read. | No |
 * | `LAYOUT_NOT_DECLARED` | The storage root has no `ocfl_layout.json`. | No |
 * | `UNSUPPORTED_LAYOUT` | The storage root names a storage layout the library doesn't have. | No |
 * | `ID_INCOMPATIBLE_WITH_LAYOUT` | `create` was given an id the storage layout can't place, or `create` or `purge` an id whose lock path is too long. | No |
 * | `OBJECT_ROOT_CONFLICT` | The object root for this id holds the wrong thing. A person needs to look at it. | No |
 * | `DIRECTORY_NOT_EMPTY` | `createStorageRoot` was given a directory with something in it. | No |
 * | `OBJECT_LOCKED` | A writer holds the object's lock, or died holding it, as a write that threw `RECOVERY_NEEDED` does; see `lockedAt`. | Later, not in a loop; or recover a dead writer's unfinished write |
 * | `RECOVERY_NEEDED` | A write failed where the library can't tell or undo what happened. The object stays locked. | After recovering its unfinished write |
 * | `MUTABLE_HEAD_ACTIVE` | The object has an active mutable head, which the library doesn't support. | No |
 * | `CROSS_FILESYSTEM_MOVE` | The workspace and the object are on different file systems. | No |
 * | `UNSUPPORTED_FILESYSTEM` | The storage root's file system can't hard-link the object's lock. | No |
 * | `VERSION_LIMIT_REACHED` | The object's zero-padded version names have run out. | No |
 * | `VERSION_NOT_FOUND` | `object.version()` was given a number that isn't a version, or `reinstate` one that isn't committed. | No |
 * | `FILE_NOT_FOUND` | `version.file()` found no file at a logical path; a draft operation found nothing there, in the draft or in the version to reinstate from. | No |
 * | `PATH_CONFLICT` | A draft operation would make a logical path both a file and a directory. | No |
 * | `TARGET_NOT_EMPTY` | A directory was copied or renamed onto a target that has files. | With `{ merge: true }` |
 * | `INVALID_LOGICAL_PATH` | A logical path is empty, absolute or has a `..` segment, or a target is inside its source. | No |
 * | `SOURCE_CHANGED` | A file changed while `import` copied it. | Once nothing writes to it |
 * | `UNSUPPORTED_FILE_TYPE` | `import` found something that isn't a regular file or directory, such as a symbolic link. | No |
 */
type OcflErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_EXISTS'
  | 'OBJECT_OUT_OF_DATE'
  | 'INVALID_OBJECT'
  | 'STORAGE_ROOT_NOT_FOUND'
  | 'INVALID_STORAGE_ROOT'
  | 'LAYOUT_NOT_DECLARED'
  | 'UNSUPPORTED_LAYOUT'
  | 'ID_INCOMPATIBLE_WITH_LAYOUT'
  | 'OBJECT_ROOT_CONFLICT'
  | 'DIRECTORY_NOT_EMPTY'
  | 'OBJECT_LOCKED'
  | 'RECOVERY_NEEDED'
  | 'MUTABLE_HEAD_ACTIVE'
  | 'CROSS_FILESYSTEM_MOVE'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'VERSION_LIMIT_REACHED'
  | 'VERSION_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'PATH_CONFLICT'
  | 'TARGET_NOT_EMPTY'
  | 'INVALID_LOGICAL_PATH'
  | 'SOURCE_CHANGED'
  | 'UNSUPPORTED_FILE_TYPE';

interface OcflErrorOptions {
  ocflCode?: string | undefined;
  lockedAt?: Date | undefined;
  objectId?: string | undefined;
  logicalPath?: string | undefined;
  sourcePath?: string | undefined;
  /** The error being wrapped */
  cause?: unknown;
}

/**
 * The error the library throws for anything a caller might handle; recognise it with {@link isOcflError} and test `code`.
 * The message isn't part of the contract: read `objectId`, `logicalPath` and `sourcePath` instead.
 * A wrong call throws a plain `TypeError`, `RangeError` or `Error`, and an aborted signal rejects with its `reason`.
 * File system errors such as `ENOSPC` pass through untouched, unless the library knows what one means or it leaves a write
 * needing recovery: then the error has the code for that meaning, or `RECOVERY_NEEDED`, with the file system error as `cause`.
 * See the {@link https://language-research-technology.github.io/ocfl-js/guides/errors/ | errors guide}.
 * @example
 * ```ts
 * try {
 *   await object.update(details, (draft) => draft.write('notes.txt', 'Field notes'));
 * } catch (error) {
 *   if (!isOcflError(error)) throw error;
 *   switch (error.code) {
 *     case 'OBJECT_LOCKED':
 *       console.log(`Another writer has held the lock since ${error.lockedAt?.toISOString() ?? 'an unknown time'}`);
 *       break;
 *     case 'OBJECT_OUT_OF_DATE':
 *       console.log(`A version of ${error.objectId} was committed since it was opened; open it again`);
 *       break;
 *     default:
 *       throw error;
 *   }
 * }
 * ```
 */
class OcflError extends Error {
  /** What went wrong: one of {@link OcflErrorCode}, whose doc says what causes each and whether retrying helps. */
  readonly code: OcflErrorCode;
  /** The code the OCFL specification gives the rule that was broken, such as `E060`, when the fault has one. */
  declare readonly ocflCode?: string;
  /** When the object's lock was taken. Set only for `OBJECT_LOCKED`, and absent when the lock couldn't be read or was released meanwhile. */
  declare readonly lockedAt?: Date;
  /**
   * The id of the object the error is about. Set for every code about one object; absent for those about the storage root as a
   * whole, and for `INVALID_OBJECT` when the fault leaves the object's id unknown, such as an inventory its sidecar doesn't confirm.
   * For a fault in an inventory its sidecar confirms, it is the id that inventory names.
   */
  declare readonly objectId?: string;
  /**
   * The logical path at fault, as the inventory lists it: the source of `FILE_NOT_FOUND`, the target of `PATH_CONFLICT` and
   * `TARGET_NOT_EMPTY`, and the path refused with `INVALID_LOGICAL_PATH`, unless it was empty. One refused for being absolute or
   * having a `..` segment is as it was given. Absent for every other code.
   */
  declare readonly logicalPath?: string;
  /**
   * The file `import` couldn't take, for `SOURCE_CHANGED` and `UNSUPPORTED_FILE_TYPE`: the `source` given to `import`, joined
   * with the file's path below it as `path.join` does, and not resolved. Absent for every other code. No field names a place in the storage root.
   */
  declare readonly sourcePath?: string;

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
    const { ocflCode, lockedAt, objectId, logicalPath, sourcePath } = options;
    for (const [name, value] of Object.entries({ ocflCode, lockedAt, objectId, logicalPath, sourcePath })) {
      if (value !== undefined) {
        Object.assign(this, { [name]: value });
      }
    }
  }
}

/** Shared by every installed copy of the library, so each recognises the others' errors */
const BRAND = Symbol.for('ocfl-js.OcflError');
Object.defineProperty(OcflError.prototype, BRAND, { value: true });

/**
 * Whether `error` is an {@link OcflError}, with `code` when given, narrowing `error.code` to it. Unlike `instanceof`, it
 * recognises an `OcflError` from another installed copy of this release or a later one.
 * @example
 * ```ts
 * if (isOcflError(error, 'SOURCE_CHANGED')) retryFile(error.sourcePath);
 * ```
 */
function isOcflError<Code extends OcflErrorCode = OcflErrorCode>(error: unknown, code?: Code): error is OcflError & { readonly code: Code } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [BRAND]?: unknown })[BRAND] === true &&
    (code === undefined || (error as { code?: unknown }).code === code)
  );
}

const ocflError: (code: OcflErrorCode, message: string, options?: OcflErrorOptions) => OcflError = OcflError._create;

/**
 * For an `objectRoot` that the storage layout gives to the object `id`, but that holds the wrong thing.
 * @param what - Completes "…places <id>, …", such as "is not empty"
 */
function objectRootConflict(objectRoot: string, id: string, what: string): OcflError {
  return ocflError('OBJECT_ROOT_CONFLICT', `${objectRoot}, where the storage root places <${id}>, ${what}.`, { objectId: id });
}

export { isOcflError, OcflError, type OcflErrorCode, objectRootConflict, ocflError };
