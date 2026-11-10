import type { OcflVersion } from './types.ts';

interface Constants {
  OCFL_VERSION: OcflVersion;
  OCFL_VERSIONS: readonly ['1.1', '1.0'];
  OCFL_LAYOUT: string;
  NAMASTE_T: string;
  NAMASTE_PREFIX_OBJECT: string;
  NAMASTE_PREFIX_STORAGE: string;
  INVENTORY_NAME: string;
  EXTENSIONS_DIR: string;
  EXTENSION_CONFIG: string;
}

const OcflConstants: Constants = {
  OCFL_VERSION: '1.1',
  OCFL_VERSIONS: Object.freeze(['1.1', '1.0'] as const),
  OCFL_LAYOUT: 'ocfl_layout.json',
  NAMASTE_T: '0=',
  NAMASTE_PREFIX_OBJECT: 'ocfl_object_',
  NAMASTE_PREFIX_STORAGE: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
};

export { OcflConstants };
