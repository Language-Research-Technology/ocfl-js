const {OcflStorageLayout} = require("../extension");

class NTupleOmitPrefixStorageLayout extends OcflStorageLayout {
  static get NAME() { return '0007-n-tuple-omit-prefix-storage-layout' }
}

module.exports = { NTupleOmitPrefixStorageLayout };