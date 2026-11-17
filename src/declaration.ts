import { OcflConstants, type OcflSpecVersion } from './constants.ts';
import { readIfPresent } from './file-system.ts';
import { specViolation } from './ocfl-rules.ts';

const { OBJECT_DECLARATION_PREFIX } = OcflConstants;

/** {@link findDeclaredVersion} for a directory holding more than one declaration */
const SEVERAL_DECLARATIONS = 'several';

/** What {@link findDeclaredVersion} finds in a directory that has a declaration */
type DeclarationsFound = OcflSpecVersion | '' | typeof SEVERAL_DECLARATIONS;

/**
 * The OCFL version declared in `rootPath` by a declaration named for `prefix`.
 * @returns The version, `''` if its declaration has the wrong contents, {@link SEVERAL_DECLARATIONS} if there is more than one,
 * or `undefined` if there is none
 */
async function findDeclaredVersion(prefix: string, rootPath: string): Promise<DeclarationsFound | undefined> {
  const declarationPath = `${rootPath}/${OcflConstants.DECLARATION_TAG}${prefix}`;
  const reads = await Promise.all(OcflConstants.OCFL_VERSIONS.map(async (version) => ({ version, text: await readIfPresent(declarationPath + version) })));
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
 * The OCFL version the declaration `declared`, found in `objectRoot`, gives
 * @throws {@link OcflError} `INVALID_OBJECT` with `E003` for more than one declaration, or `E007` for one with the wrong contents
 */
function checkedDeclaration(objectRoot: string, declared: DeclarationsFound): OcflSpecVersion {
  if (declared === SEVERAL_DECLARATIONS) {
    throw specViolation('E003', objectRoot, 'it has more than one object declaration');
  }
  if (declared === '') {
    throw specViolation('E007', objectRoot);
  }
  return declared;
}

/**
 * The OCFL version the object declaration in `objectRoot` gives, or `undefined` if it has none
 * @throws {@link OcflError} `INVALID_OBJECT` as {@link checkedDeclaration} does
 */
async function objectDeclaration(objectRoot: string): Promise<OcflSpecVersion | undefined> {
  const declared = await findDeclaredVersion(OBJECT_DECLARATION_PREFIX, objectRoot);
  return declared === undefined ? undefined : checkedDeclaration(objectRoot, declared);
}

/** Whether `dir` has an object declaration file, whatever it holds */
async function hasObjectDeclaration(dir: string): Promise<boolean> {
  return (await findDeclaredVersion(OBJECT_DECLARATION_PREFIX, dir)) !== undefined;
}

export { checkedDeclaration, type DeclarationsFound, findDeclaredVersion, hasObjectDeclaration, objectDeclaration, SEVERAL_DECLARATIONS };
