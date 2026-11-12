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

export { OcflConstants, type OcflVersion };
