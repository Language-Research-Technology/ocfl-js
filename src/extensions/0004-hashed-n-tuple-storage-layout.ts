import path from 'node:path';
import * as Hashing from '../digest.ts';
import { OcflError } from '../error.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';
import { checkNTupleParameters } from './n-tuple.ts';

export type HashedNTupleStorageLayoutConfig = {
  digestAlgorithm?: string;
  tupleSize?: number;
  numberOfTuples?: number;
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
    const digestLength = checkNTupleParameters(this.parameters);
    const c = this.parameters;
    if (c.tupleSize * c.numberOfTuples === digestLength && c.shortObjectRoot) {
      throw new OcflError('INVALID_LAYOUT_CONFIG', 'shortObjectRoot cannot be set to true when the tuples use the whole digest.');
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
