const { OcflStorageLayout } = require("../extension");
const { OcflDigest } = require("../digest");
const { enumeration } = require("../enum");
const path = require("path");

function encodeIdentifier(id) {
  return encodeURIComponent(id).toLowerCase().replace(/\./g, '%2e');
}

const DefaultConfig = {
  extensionName: '0003-hash-and-id-n-tuple-storage-layout',
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
};

/**
 * @extends {OcflStorageLayout<typeof DefaultConfig>}
 */
class HashAndIdNTupleStorageLayout extends OcflStorageLayout {
  static get NAME() { return DefaultConfig.extensionName }
  static get DESCRIPTION() {
    return "OCFL object identifiers are hashed and encoded as lowercase hex strings." +
      " These digests are then divided into N n-tuple segments," +
      " which are used to create nested paths under the OCFL storage root." +
      " Finally, the OCFL object identifier is percent-encoded to create a directory name for the OCFL object root.";
  }

  /**
   * @param {Partial<typeof DefaultConfig>} [config] 
   */
  constructor(config) {
    super(config, DefaultConfig);
    let c = this.parameters;
    const algo = enumeration.of(OcflDigest.FIXITY, c.digestAlgorithm)?.name;
    if (!algo) throw new Error('Invalid digestAlgorithm');
    let digestLength = OcflDigest.getHexDigestLength(algo);
    let p = c.numberOfTuples * c.tupleSize
    if (p > digestLength) throw new Error('Product of numberOfTuples and tupleSize is greater than the number of characters in the hex encoded digest.');
  }

  /**
   * @param {string} id
   * @return {string} 
   */
  map(id) {
    let digest = OcflDigest.digestSync(this.parameters.digestAlgorithm, id);
    let segments = [];
    let s = this.parameters.tupleSize;
    let n = this.parameters.numberOfTuples;
    let i;
    for (i = 0; i < n; ++i) {
      segments.push(digest.slice(s * i, s * i + s));
    }
    segments.push(encodeIdentifier(id));
    return segments.join(path.sep);
  }
}

module.exports = { HashAndIdNTupleStorageLayout };