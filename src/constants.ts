import fs from 'node:fs';
import { isNotDir, isNotFound } from './file-system.ts';

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

/**
 * Check if there is any valid namaste in the rootPath and return the version number.
 * @returns The version, `''` if a namaste exists but is invalid, or `undefined` if there is none.
 */
async function findNamasteVersion(prefix: string, rootPath: string): Promise<OcflVersion | '' | undefined> {
  const namastePath = `${rootPath}/${OcflConstants.NAMASTE_T}${prefix}`;
  try {
    const version = await Promise.any(
      OcflConstants.OCFL_VERSIONS.map(async (v) => ((await fs.promises.readFile(namastePath + v, 'utf8')) === `${prefix}${v}\n` ? v : null)),
    );
    return version ?? '';
  } catch (error) {
    // ENOTDIR: the root is a file, which can't hold a declaration
    const failure = (error as AggregateError).errors.find((e) => !isNotFound(e) && !isNotDir(e));
    if (failure) {
      throw failure;
    }
    return undefined;
  }
}

export { findNamasteVersion, OcflConstants, type OcflVersion };
