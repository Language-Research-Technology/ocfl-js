const {OcflStorageLayout} = require("../extension");

class FlatOmitPrefixStorageLayout extends OcflStorageLayout {
  static get NAME() { return '0006-flat-omit-prefix-storage-layout' }
}

module.exports = { FlatOmitPrefixStorageLayout };