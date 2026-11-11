import { type OcflError, ocflError } from './error.ts';

// The OCFL 1.1 validation codes this library raises: https://ocfl.io/1.1/spec/validation-codes.html
type ValidationCode =
  | 'E007'
  | 'E017'
  | 'E018'
  | 'E036'
  | 'E040'
  | 'E050'
  | 'E057'
  | 'E058'
  | 'E060'
  | 'E069'
  | 'E070'
  | 'E080'
  | 'E082'
  | 'E096'
  | 'E099'
  | 'E100'
  | 'E104'
  | 'E111';

type Violated = 'INVALID_OBJECT' | 'INVALID_STORAGE_ROOT';

const RULES: Record<ValidationCode, [violated: Violated, description: string]> = {
  E007: ['INVALID_OBJECT', 'The text contents of the [version declaration] file must be the same as dvalue, followed by a newline (\\n).'],
  E017: ['INVALID_OBJECT', 'The contentDirectory value MUST NOT contain the forward slash (/) path separator.'],
  E018: ['INVALID_OBJECT', 'The contentDirectory value MUST NOT be either one or two periods (. or ..).'],
  E036: ['INVALID_OBJECT', 'An OCFL Object Inventory MUST include the following keys: [id, type, digestAlgorithm, head].'],
  E040: ['INVALID_OBJECT', '[head] MUST be the version directory name with the highest version number.'],
  E050: [
    'INVALID_OBJECT',
    'The keys of [the state JSON object] are digest values, each of which MUST correspond to an entry in the manifest of the inventory.',
  ],
  E057: [
    'INVALID_OBJECT',
    'The value of the fixity block for a particular digest algorithm MUST follow the structure of the manifest block; that is, a key corresponding to the digest value, and an array of content paths that match that digest.',
  ],
  E058: ['INVALID_OBJECT', 'Every occurrence of an inventory file MUST have an accompanying sidecar file stating its digest.'],
  E060: ['INVALID_OBJECT', 'The digest sidecar file must contain the digest of the inventory file.'],
  E069: ['INVALID_STORAGE_ROOT', 'An OCFL Storage Root MUST contain a Root Conformance Declaration identifying it as such.'],
  E070: [
    'INVALID_STORAGE_ROOT',
    'If present, [the ocfl_layout.json document] MUST include the following two keys in the root JSON object: [extension, description].',
  ],
  E080: ['INVALID_STORAGE_ROOT', 'The text contents of [the OCFL version declaration file] MUST be the same as dvalue, followed by a newline (\\n).'],
  E082: [
    'INVALID_OBJECT',
    'OCFL Object Roots MUST be stored either as the terminal resource at the end of a directory storage hierarchy or as direct children of a containing OCFL Storage Root.',
  ],
  E096: [
    'INVALID_OBJECT',
    'As JSON keys are case sensitive, while digests may not be, there is an additional requirement that each digest value MUST occur only once in the manifest regardless of case.',
  ],
  E099: ['INVALID_OBJECT', 'Path elements [of a content path] MUST NOT be ., .., or empty (//).'],
  E100: ['INVALID_OBJECT', 'A content path MUST NOT begin or end with a forward slash (/).'],
  E104: ['INVALID_OBJECT', 'Version directory names MUST be constructed by prepending v to the version number.'],
  E111: ['INVALID_OBJECT', 'If present, [the fixity block] MUST be a JSON object, which MAY be empty.'],
};

/**
 * The `INVALID_OBJECT` or `INVALID_STORAGE_ROOT` error, whichever the rule is about, for a broken OCFL rule
 * @param code - OCFL validation code, eg 'E060', which becomes the error's `ocflCode`
 * @param path - Path the problem was found at
 * @param detail - Extra context appended to the message
 */
export function createError(code: ValidationCode, path: string, detail?: string): OcflError {
  const [violated, description] = RULES[code];
  return ocflError(violated, `${code}: ${description} At ${path}${detail ? ` (${detail})` : ''}`, { ocflCode: code });
}
