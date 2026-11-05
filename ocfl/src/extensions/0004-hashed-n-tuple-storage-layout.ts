import path from 'node:path';
import { OcflDigest } from '../digest.ts';
import { OcflStorageLayout } from '../extension.ts';

const DefaultConfig = {
  extensionName: '0004-hashed-n-tuple-storage-layout',
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
  shortObjectRoot: false,
};
export type HashedNTupleStorageLayoutConfig = Partial<typeof DefaultConfig>;

class HashedNTupleStorageLayout extends OcflStorageLayout<typeof DefaultConfig> {
  static get NAME(): string {
    return DefaultConfig.extensionName;
  }
  static get DESCRIPTION(): string {
    return (
      'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
      ' These digests are then divided into N n-tuple segments,' +
      ' which are used to create nested paths under the OCFL storage root.'
    );
  }

  constructor(config?: HashedNTupleStorageLayoutConfig) {
    super(config, DefaultConfig);
    const c = this.parameters;
    const digestLength = OcflDigest.getHexDigestLength(c.digestAlgorithm);
    if (!digestLength) {
      throw new Error('Invalid digestAlgorithm');
    }
    const p = c.numberOfTuples * c.tupleSize;
    if (p > digestLength) {
      throw new Error('Product of numberOfTuples and tupleSize is greater than the number of characters in the hex encoded digest.');
    } else if (p === digestLength && c.shortObjectRoot) {
      throw new Error('shortObjectRoot cannot be set to true');
    }
  }

  map(id: string): string {
    const digest = OcflDigest.digestSync(this.parameters.digestAlgorithm, id);
    const segments = [];
    const s = this.parameters.tupleSize;
    const n = this.parameters.numberOfTuples;
    let i: number;
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

export { HashedNTupleStorageLayout };
