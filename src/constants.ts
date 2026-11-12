const OcflConstants = {
  OCFL_VERSION: '1.1',
  OCFL_VERSIONS: Object.freeze(['1.1', '1.0'] as const) as readonly ['1.1', '1.0'],
  OCFL_LAYOUT: 'ocfl_layout.json',
  NAMASTE_T: '0=',
  NAMASTE_PREFIX_OBJECT: 'ocfl_object_',
  NAMASTE_PREFIX_STORAGE: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
  WORKSPACE_EXTENSION: 'ocfl-js-workspace',
} as const;

type OcflVersion = (typeof OcflConstants.OCFL_VERSIONS)[number];

export { OcflConstants, type OcflVersion };
