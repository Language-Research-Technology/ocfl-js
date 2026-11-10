import { OcflError } from './error.ts';

// Messages for the OCFL 1.1 validation codes this library raises: https://ocfl.io/1.1/spec/validation-codes.html
export type ValidationErrorCode = 'E007' | 'E036' | 'E040' | 'E050' | 'E060' | 'E069' | 'E070' | 'E080' | 'E081' | 'E082';

const ERRORS: Record<ValidationErrorCode, string> = {
  E007: 'The text contents of the [version declaration] file must be the same as dvalue, followed by a newline (\\n).',
  E036: 'An OCFL Object Inventory MUST include the following keys: [id, type, digestAlgorithm, head].',
  E040: '[head] MUST be the version directory name with the highest version number.',
  E050: 'The keys of [the state JSON object] are digest values, each of which MUST correspond to an entry in the manifest of the inventory.',
  E060: 'The digest sidecar file must contain the digest of the inventory file.',
  E069: 'An OCFL Storage Root MUST contain a Root Conformance Declaration identifying it as such.',
  E070: 'If present, [the ocfl_layout.json document] MUST include the following two keys in the root JSON object: [extension, description].',
  E080: 'The text contents of [the OCFL version declaration file] MUST be the same as dvalue, followed by a newline (\\n).',
  E081: 'OCFL Objects within the OCFL Storage Root also include a conformance declaration which MUST indicate OCFL Object conformance to the same or earlier version of the specification.',
  E082: 'OCFL Object Roots MUST be stored either as the terminal resource at the end of a directory storage hierarchy or as direct children of a containing OCFL Storage Root.',
};

export interface ValidationErrorOptions {
  code: ValidationErrorCode;
  description: string;
  path: string;
  detail?: string | undefined;
}

export class ValidationError extends OcflError {
  declare code: ValidationErrorCode;
  declare description: string;
  declare path: string;
  declare detail?: string | undefined;

  constructor(options: ValidationErrorOptions) {
    super(options.code, `${options.code}: ${options.description} At ${options.path}${options.detail ? ` (${options.detail})` : ''}`);
    this.name = 'ValidationError';
    Object.assign(this, options);
  }
}

/**
 * @param code - OCFL validation code, eg 'E060'
 * @param path - Path the problem was found at
 * @param detail - Extra context appended to the message
 */
export const createError = (code: ValidationErrorCode, path: string, detail?: string): ValidationError => {
  const description = Object.hasOwn(ERRORS, code) ? ERRORS[code] : undefined;
  if (!description) {
    throw new RangeError(`Unknown OCFL validation code ${code}`);
  }
  return new ValidationError({ code, description, path, detail });
};
