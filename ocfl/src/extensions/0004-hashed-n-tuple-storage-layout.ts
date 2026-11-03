const { OcflStorageLayout } = require('../extension');
const { OcflDigest } = require('../digest');
const path = require('path');
const { enumeration } = require('../enum');

const DefaultConfig = {
  extensionName: '0004-hashed-n-tuple-storage-layout',
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
  shortObjectRoot: false,
};
/** @typedef {Partial<typeof DefaultConfig>} HashedNTupleStorageLayoutConfig */
/**
 * @extends {OcflStorageLayout<typeof DefaultConfig>}
 */
class HashedNTupleStorageLayout extends OcflStorageLayout {
  static get NAME() {
    return DefaultConfig.extensionName;
  }
  static get DESCRIPTION() {
    return (
      'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
      ' These digests are then divided into N n-tuple segments,' +
      ' which are used to create nested paths under the OCFL storage root.'
    );
  }

  /**
   *
   * @param {HashedNTupleStorageLayoutConfig} [config]
   */
  constructor(config) {
    super(config, DefaultConfig);
    const c = this.parameters;
    const algo = enumeration.of(OcflDigest.FIXITY, c.digestAlgorithm)?.name;
    if (!algo) throw new Error('Invalid digestAlgorithm');
    const digestLength = OcflDigest.getHexDigestLength(algo);
    const p = c.numberOfTuples * c.tupleSize;
    if (p > digestLength) throw new Error('Product of numberOfTuples and tupleSize is greater than the number of characters in the hex encoded digest.');
    else if (p === digestLength && c.shortObjectRoot) throw new Error('shortObjectRoot cannot be set to true');
  }

  /**
   * @param {string} id
   * @return {string}
   */
  map(id) {
    const digest = OcflDigest.digestSync(this.parameters.digestAlgorithm, id);
    const segments = [];
    const s = this.parameters.tupleSize;
    const n = this.parameters.numberOfTuples;
    let i;
    for (i = 0; i < n; ++i) {
      segments.push(digest.slice(s * i, s * i + s));
    }
    if (this.parameters.shortObjectRoot) {
      segments.push(digest.slice(s * i));
    } else {
      segments.push(digest);
    }
    return segments.join(path.sep);
  }
}

module.exports = { HashedNTupleStorageLayout };
