import { readIfPresent } from './file-system.ts';

/** An OCFL specification version this library reads and writes. */
type OcflVersion = '1.0' | '1.1';

const OcflConstants = {
  OCFL_VERSION: '1.1',
  OCFL_VERSIONS: Object.freeze<OcflVersion[]>(['1.1', '1.0']) as readonly OcflVersion[],
  OCFL_LAYOUT: 'ocfl_layout.json',
  NAMASTE_T: '0=',
  NAMASTE_PREFIX_OBJECT: 'ocfl_object_',
  NAMASTE_PREFIX_STORAGE: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
  WORKSPACE_EXTENSION: 'ocfl-js-workspace',
} as const;

/** {@link findNamasteVersion} for a directory holding more than one declaration */
const SEVERAL_DECLARATIONS = 'several';

/** What {@link findNamasteVersion} finds in a directory that has a declaration */
type DeclarationsFound = OcflVersion | '' | typeof SEVERAL_DECLARATIONS;

/**
 * The OCFL version declared in `rootPath` by a namaste file named for `prefix`.
 * @returns The version, `''` if its declaration has the wrong contents, {@link SEVERAL_DECLARATIONS} if there is more than one,
 * or `undefined` if there is none
 */
async function findNamasteVersion(prefix: string, rootPath: string): Promise<DeclarationsFound | undefined> {
  const namastePath = `${rootPath}/${OcflConstants.NAMASTE_T}${prefix}`;
  const reads = await Promise.all(OcflConstants.OCFL_VERSIONS.map(async (version) => ({ version, text: await readIfPresent(namastePath + version) })));
  const declared = reads.filter((read): read is { version: OcflVersion; text: string } => read.text !== undefined);
  if (declared.length > 1) {
    return SEVERAL_DECLARATIONS;
  }
  const [only] = declared;
  if (only === undefined) {
    return undefined;
  }
  return only.text === `${prefix}${only.version}\n` ? only.version : '';
}

export { type DeclarationsFound, findNamasteVersion, OcflConstants, type OcflVersion, SEVERAL_DECLARATIONS };
