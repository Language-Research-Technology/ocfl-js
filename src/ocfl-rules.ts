import { type OcflError, ocflError } from './error.ts';

// The OCFL 1.1 validation codes this library raises: https://ocfl.io/1.1/spec/validation-codes.html
export type ValidationCode =
  | 'E003'
  | 'E007'
  | 'E009'
  | 'E010'
  | 'E011'
  | 'E012'
  | 'E017'
  | 'E018'
  | 'E025'
  | 'E033'
  | 'E036'
  | 'E040'
  | 'E048'
  | 'E049'
  | 'E050'
  | 'E052'
  | 'E053'
  | 'E057'
  | 'E058'
  | 'E060'
  | 'E063'
  | 'E069'
  | 'E070'
  | 'E076'
  | 'E080'
  | 'E081'
  | 'E082'
  | 'E095'
  | 'E096'
  | 'E099'
  | 'E100'
  | 'E104'
  | 'E111';

type Violated = 'INVALID_OBJECT' | 'INVALID_STORAGE_ROOT';

const RULES: Record<ValidationCode, [violated: Violated, description: string]> = {
  E003: [
    'INVALID_OBJECT',
    'There MUST be exactly one version declaration file in the base directory of the OCFL Object Root giving the OCFL version in the filename.',
  ],
  E007: ['INVALID_OBJECT', 'The text contents of the [version declaration] file must be the same as dvalue, followed by a newline (\\n).'],
  E009: ['INVALID_OBJECT', 'The version number sequence MUST start at 1.'],
  E010: ['INVALID_OBJECT', 'The version number sequence MUST be continuous without missing integers.'],
  E011: ['INVALID_OBJECT', 'If zero-padded version directory numbers are used then they MUST start with the prefix v and then a zero.'],
  E012: [
    'INVALID_OBJECT',
    'All version directories of an object MUST use the same naming convention: either a non-padded version directory number, or a zero-padded version directory number of consistent length.',
  ],
  E017: ['INVALID_OBJECT', 'The contentDirectory value MUST NOT contain the forward slash (/) path separator.'],
  E018: ['INVALID_OBJECT', 'The contentDirectory value MUST NOT be either one or two periods (. or ..).'],
  E025: ['INVALID_OBJECT', 'For content-addressing, OCFL Objects MUST use either sha512 or sha256, and SHOULD use sha512.'],
  E033: ['INVALID_OBJECT', 'An OCFL Object Inventory MUST follow the [JSON] structure described in this section and MUST be named inventory.json.'],
  E036: ['INVALID_OBJECT', 'An OCFL Object Inventory MUST include the following keys: [id, type, digestAlgorithm, head].'],
  E040: ['INVALID_OBJECT', '[head] MUST be the version directory name with the highest version number.'],
  E048: ['INVALID_OBJECT', 'A JSON object to describe one OCFL Version, which MUST include the following keys: [created, state].'],
  E049: ['INVALID_OBJECT', '[the value of the created key] MUST be expressed in the Internet Date/Time Format defined by [RFC3339].'],
  E050: [
    'INVALID_OBJECT',
    'The keys of [the state JSON object] are digest values, each of which MUST correspond to an entry in the manifest of the inventory.',
  ],
  E052: ['INVALID_OBJECT', 'Path elements [of a logical path] MUST NOT be ., .., or empty (//).'],
  E053: ['INVALID_OBJECT', 'A logical path MUST NOT begin or end with a forward slash (/).'],
  E057: [
    'INVALID_OBJECT',
    'The value of the fixity block for a particular digest algorithm MUST follow the structure of the manifest block; that is, a key corresponding to the digest value, and an array of content paths that match that digest.',
  ],
  E058: ['INVALID_OBJECT', 'Every occurrence of an inventory file MUST have an accompanying sidecar file stating its digest.'],
  E060: ['INVALID_OBJECT', 'The digest sidecar file must contain the digest of the inventory file.'],
  E063: [
    'INVALID_OBJECT',
    'Every OCFL Object MUST have an inventory file within the OCFL Object Root, corresponding to the state of the OCFL Object at the current version.',
  ],
  E069: ['INVALID_STORAGE_ROOT', 'An OCFL Storage Root MUST contain a Root Conformance Declaration identifying it as such.'],
  E070: [
    'INVALID_STORAGE_ROOT',
    'If present, [the ocfl_layout.json document] MUST include the following two keys in the root JSON object: [extension, description].',
  ],
  E076: [
    'INVALID_STORAGE_ROOT',
    'There MUST be exactly one version declaration file in the base directory of the OCFL Storage Root giving the OCFL version in the filename.',
  ],
  E080: ['INVALID_STORAGE_ROOT', 'The text contents of [the OCFL version declaration file] MUST be the same as dvalue, followed by a newline (\\n).'],
  E081: ['INVALID_OBJECT', "An OCFL Object's version MUST be less than or equal to the version of the OCFL Storage Root it is in."],
  E082: [
    'INVALID_OBJECT',
    'OCFL Object Roots MUST be stored either as the terminal resource at the end of a directory storage hierarchy or as direct children of a containing OCFL Storage Root.',
  ],
  E095: [
    'INVALID_OBJECT',
    'Within a version, logical paths MUST be unique and non-conflicting, so the logical path for a file cannot appear as the initial part of another logical path.',
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

/** Where a broken rule was found: the path it was found at, the id of the object whose inventory has it, or both */
export type FaultAt = string | { objectId: string; file?: string };

/**
 * The `INVALID_OBJECT` or `INVALID_STORAGE_ROOT` error, whichever the rule is about, for a broken OCFL rule
 * @param code - OCFL validation code, eg 'E060', which becomes the error's `ocflCode`
 * @param detail - Extra context appended to the message
 */
export function specViolation(code: ValidationCode, where: FaultAt, detail?: string, options: { cause?: unknown } = {}): OcflError {
  const [violated, description] = RULES[code];
  const at = typeof where === 'string' ? `At ${where}` : `${where.file === undefined ? 'In' : `At ${where.file}, in`} the object <${where.objectId}>`;
  return ocflError(violated, `${code}: ${description} ${at}${detail ? ` (${detail})` : ''}`, { ...options, ocflCode: code });
}
