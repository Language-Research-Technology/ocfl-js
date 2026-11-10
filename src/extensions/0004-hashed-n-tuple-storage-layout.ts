import path from 'node:path';
import { Hashing } from '../digest.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';
import type { HashAndIdNTupleStorageLayoutConfig } from './0003-hash-and-id-n-tuple-storage-layout.ts';

export type HashedNTupleStorageLayoutConfig = HashAndIdNTupleStorageLayoutConfig & {
  shortObjectRoot?: boolean;
};

const DefaultConfig: Required<HashedNTupleStorageLayoutConfig> = {
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
  shortObjectRoot: false,
};

class HashedNTupleStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name = '0004-hashed-n-tuple-storage-layout';
  readonly description: string =
    'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
    ' These digests are then divided into N n-tuple segments,' +
    ' which are used to create nested paths under the OCFL storage root.';

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    const c = this.parameters;
    const digestLength = Hashing.getHexDigestLength(c.digestAlgorithm);
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
    const digest = Hashing.digestSync(this.parameters.digestAlgorithm, id);
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
