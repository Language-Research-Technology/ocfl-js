import path from 'node:path';
import { Hashing } from '../digest.ts';
import { OcflStorageLayout } from '../extension.ts';

const MAX_ENCODED_ID_LENGTH = 100;

function encapsulationDirectory(id: string, digest: string) {
  const encoded = encodeURIComponent(id)
    .replace(/%[0-9A-F]{2}/g, (hexEscape) => hexEscape.toLowerCase())
    .replace(/[.!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return encoded.length > MAX_ENCODED_ID_LENGTH ? `${encoded.slice(0, MAX_ENCODED_ID_LENGTH)}-${digest}` : encoded;
}

const DefaultConfig = {
  extensionName: '0003-hash-and-id-n-tuple-storage-layout',
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
};

class HashAndIdNTupleStorageLayout extends OcflStorageLayout<typeof DefaultConfig> {
  static get NAME() {
    return DefaultConfig.extensionName;
  }
  static get DESCRIPTION() {
    return (
      'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
      ' These digests are then divided into N n-tuple segments,' +
      ' which are used to create nested paths under the OCFL storage root.' +
      ' Finally, the OCFL object identifier is percent-encoded to create a directory name for the OCFL object root.'
    );
  }

  constructor(config?: Partial<typeof DefaultConfig>) {
    super(config, DefaultConfig);
    const c = this.parameters;
    const digestLength = Hashing.getHexDigestLength(c.digestAlgorithm);
    if (!digestLength) {
      throw new Error('Invalid digestAlgorithm');
    }
    const p = c.numberOfTuples * c.tupleSize;
    if (p > digestLength) {
      throw new Error('Product of numberOfTuples and tupleSize is greater than the number of characters in the hex encoded digest.');
    }
  }

  map(id: string): string {
    const digest = Hashing.digestSync(this.parameters.digestAlgorithm, id);
    const segments = [];
    const s = this.parameters.tupleSize;
    const n = this.parameters.numberOfTuples;
    let i: number;
    for (i = 0; i < n; ++i) {
      segments.push(digest.slice(s * i, s * i + s));
    }
    segments.push(encapsulationDirectory(id, digest));
    return segments.join(path.sep);
  }
}

export { HashAndIdNTupleStorageLayout };
