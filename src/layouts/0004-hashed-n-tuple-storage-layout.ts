import path from 'node:path';
import type { FixityAlgorithm } from '../digest.ts';
import * as Hashing from '../digest.ts';
import { BuiltInLayout, type OcflExtensionConfig } from './built-in-layout.ts';
import { checkNTupleParameters, tupleSegments } from './n-tuple.ts';

/** Object roots named by their id's digest, nested under pieces of it. */
export interface HashedNTupleLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0004-hashed-n-tuple-storage-layout';
  /** Algorithm used to hash the id. Defaults to `sha256`. */
  digestAlgorithm?: FixityAlgorithm;
  /** Characters of the digest in each directory level. Defaults to 3. */
  tupleSize?: number;
  /** Number of directory levels. Defaults to 3. */
  numberOfTuples?: number;
  /** Name the object root with only the rest of the digest. Defaults to `false`. */
  shortObjectRoot?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<HashedNTupleLayoutConfig, 'extensionName'>> = {
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
  shortObjectRoot: false,
};

export class HashedNTupleStorageLayout extends BuiltInLayout<typeof DEFAULT_CONFIG> {
  readonly name = '0004-hashed-n-tuple-storage-layout';
  readonly description: string =
    'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
    ' These digests are then divided into N n-tuple segments,' +
    ' which are used to create nested paths under the OCFL storage root.';

  constructor(config?: OcflExtensionConfig) {
    super(config, DEFAULT_CONFIG);
    const digestLength = checkNTupleParameters(this.parameters);
    const { tupleSize, numberOfTuples, shortObjectRoot } = this.parameters;
    if (tupleSize * numberOfTuples === digestLength && shortObjectRoot) {
      throw new TypeError("shortObjectRoot can't be true when the tuples use the whole digest.");
    }
  }

  map(id: string): string {
    const digest = Hashing.digestSync(this.parameters.digestAlgorithm, id);
    const { tupleSize, numberOfTuples, shortObjectRoot } = this.parameters;
    const objectRoot = shortObjectRoot ? digest.slice(tupleSize * numberOfTuples) : digest;
    return [...tupleSegments(digest, this.parameters), objectRoot].join(path.sep);
  }
}
