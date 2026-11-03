// Messages for the OCFL 1.1 validation codes this library raises: https://ocfl.io/1.1/spec/validation-codes.html
const ERRORS = {
  E007: 'The text contents of the [version declaration] file must be the same as dvalue, followed by a newline (\\n).',
  E060: 'The digest sidecar file must contain the digest of the inventory file.',
  E069: 'An OCFL Storage Root MUST contain a Root Conformance Declaration identifying it as such.',
  E080: 'The text contents of [the OCFL version declaration file] MUST be the same as dvalue, followed by a newline (\\n).',
  E082: 'OCFL Object Roots MUST be stored either as the terminal resource at the end of a directory storage hierarchy or as direct children of a containing OCFL Storage Root.',
};

type ErrorCode = keyof typeof ERRORS;

interface ValidationErrorOptions {
  code: ErrorCode;
  description: string;
  path: string;
  detail?: string;
}

class ValidationError extends Error {
  declare code: ErrorCode;
  declare description: string;
  declare path: string;
  declare detail?: string;

  constructor(options: ValidationErrorOptions) {
    super(`${options.code}: ${options.description} At ${options.path}${options.detail ? ` (${options.detail})` : ''}`);
    this.name = 'ValidationError';
    Object.assign(this, options);
  }
}

/**
 * @param code - OCFL validation code, eg 'E060'
 * @param path - Path the problem was found at
 * @param detail - Extra context appended to the message
 */
export const createError = (code: ErrorCode, path: string, detail?: string) => {
  const description = Object.hasOwn(ERRORS, code) ? ERRORS[code] : undefined;
  if (!description) {
    throw new RangeError(`Unknown OCFL validation code ${code}`);
  }
  return new ValidationError({ code, description, path, detail });
};

class Validator {
  /**
   * From the spec: the contentDirectory value must not contain the forward slash (/) path separator
   * and must not be either one or two periods (. or ..)
   */
  validateContentDirectoryName(_name: string) {
    // if (name === '.' || name === '..' || name.includes('/')) {
    //   throw new validation.Error('contentDirectory is invalid'); 16, 17
    // }
  }
  /**
   * If the key contentDirectory is set, it must be set in the first version of the object and must not change between versions of the same object.
   * Every file within a version's content directory must be referenced in the manifest section of that version's inventory. There must not be empty directories within a version's content directory.
   */
  validateContentDirectory() {}
  validateInventory(inventory: { id: string }) {
    new URL(inventory.id);
  }
}
