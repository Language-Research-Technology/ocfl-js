import { OCFL_CONSTANTS, type OcflSpecVersion } from './constants.ts';
import { readIfPresent } from './file-system.ts';
import { type FaultAt, specViolation } from './ocfl-rules.ts';

const { OBJECT_DECLARATION_PREFIX } = OCFL_CONSTANTS;

/** {@link findDeclaredVersion} for a directory holding more than one declaration */
export const SEVERAL_DECLARATIONS = 'several';

/** What {@link findDeclaredVersion} finds in a directory that has a declaration */
export type DeclarationsFound = OcflSpecVersion | '' | typeof SEVERAL_DECLARATIONS;

/**
 * The OCFL version declared in `rootPath` by a declaration named for `prefix`.
 * @returns The version, `''` if its declaration has the wrong contents, {@link SEVERAL_DECLARATIONS} if there is more than one,
 * or `undefined` if there is none
 */
export async function findDeclaredVersion(prefix: string, rootPath: string): Promise<DeclarationsFound | undefined> {
  const declarationPath = `${rootPath}/${OCFL_CONSTANTS.DECLARATION_TAG}${prefix}`;
  const reads = await Promise.all(OCFL_CONSTANTS.OCFL_VERSIONS.map(async (version) => ({ version, text: await readIfPresent(declarationPath + version) })));
  const declared = reads.filter((read): read is { version: OcflSpecVersion; text: string } => read.text !== undefined);
  if (declared.length > 1) {
    return SEVERAL_DECLARATIONS;
  }
  const [only] = declared;
  if (only === undefined) {
    return undefined;
  }
  return only.text === `${prefix}${only.version}\n` ? only.version : '';
}

/**
 * The OCFL version the declaration `declared`, found where `where` says, gives
 * @throws {@link OcflError} `INVALID_OBJECT` with `E003` for more than one declaration, or `E007` for one with the wrong contents
 */
export function checkedDeclaration(where: FaultAt, declared: DeclarationsFound): OcflSpecVersion {
  if (declared === SEVERAL_DECLARATIONS) {
    throw specViolation('E003', where, 'it has more than one object declaration');
  }
  if (declared === '') {
    throw specViolation('E007', where);
  }
  return declared;
}

/**
 * The OCFL version the object declaration in `objectRoot` gives, or `undefined` if it has none
 * @param where - The object root, and the id it is given if known, for the error
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link checkedDeclaration} does
 */
export async function objectDeclaration(objectRoot: string, where: FaultAt = objectRoot): Promise<OcflSpecVersion | undefined> {
  const declared = await findDeclaredVersion(OBJECT_DECLARATION_PREFIX, objectRoot);
  return declared === undefined ? undefined : checkedDeclaration(where, declared);
}

/** Whether `dir` has an object declaration file, whatever it holds */
export async function hasObjectDeclaration(dir: string): Promise<boolean> {
  return (await findDeclaredVersion(OBJECT_DECLARATION_PREFIX, dir)) !== undefined;
}
