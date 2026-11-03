import type { OcflVersion } from './types.ts';

const OcflConstants = {
  OCFL_VERSION: '1.1' as OcflVersion,
  OCFL_VERSIONS: Object.freeze(['1.1', '1.0'] as const),
  OCFL_LAYOUT: 'ocfl_layout.json',
  NAMASTE_T: '0=',
  NAMASTE_PREFIX_OBJECT: 'ocfl_object_',
  NAMASTE_PREFIX_STORAGE: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
  DIGEST_ALGORITHM: 'sha512',
};

export { OcflConstants };
