/** An OCFL specification version this library reads and writes. */
type OcflSpecVersion = '1.0' | '1.1';

const OcflConstants = {
  OCFL_VERSION: '1.1',
  OCFL_VERSIONS: Object.freeze<OcflSpecVersion[]>(['1.1', '1.0']) as readonly OcflSpecVersion[],
  OCFL_LAYOUT: 'ocfl_layout.json',
  DECLARATION_TAG: '0=',
  OBJECT_DECLARATION_PREFIX: 'ocfl_object_',
  STORAGE_ROOT_DECLARATION_PREFIX: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
  WORKSPACE_EXTENSION: 'ocfl-js-workspace',
  LOCK_NAME: 'lock',
} as const;

export { OcflConstants, type OcflSpecVersion };
