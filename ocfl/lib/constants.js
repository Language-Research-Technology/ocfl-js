/**
 * @module
 * default constants 
 */
// module.exports = {
//   OCFL_VERSION: 1.1,
//   NAMASTE_PREFIX_OBJECT: '0=ocfl_object_',
//   NAMASTE_PREFIX_STORAGE: '0=ocfl_',
//   INVENTORY_NAME: 'inventory.json'
// };
const OcflConstants = {
  OCFL_VERSION: '1.1',
  OCFL_VERSIONS: Object.freeze(['1.1', '1.0']),
  OCFL_LAYOUT: 'ocfl_layout.json',
  NAMASTE_T: '0=',
  NAMASTE_PREFIX_OBJECT: 'ocfl_object_',
  NAMASTE_PREFIX_STORAGE: 'ocfl_',
  INVENTORY_NAME: 'inventory.json',
  EXTENSIONS_DIR: 'extensions',
  EXTENSION_CONFIG: 'config.json',
  DIGEST_ALGORITHM: 'sha512'
};

module.exports = { OcflConstants };