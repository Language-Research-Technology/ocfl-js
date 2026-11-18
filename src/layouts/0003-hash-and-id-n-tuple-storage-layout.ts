import path from 'node:path';
import type { FixityAlgorithm } from '../digest.ts';
import * as Hashing from '../digest.ts';
import { BuiltInLayout, type OcflExtensionConfig } from './built-in-layout.ts';
import { checkNTupleParameters, tupleSegments } from './n-tuple.ts';

/** Object roots named by their encoded id, nested under pieces of the id's digest. */
export interface HashAndIdNTupleLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0003-hash-and-id-n-tuple-storage-layout';
  /** Algorithm used to hash the id. Defaults to `sha256`. */
  digestAlgorithm?: FixityAlgorithm;
  /** Characters of the digest in each directory level. Defaults to 3. */
  tupleSize?: number;
  /** Number of directory levels. Defaults to 3. */
  numberOfTuples?: number;
}

const MAX_ENCODED_ID_LENGTH = 100;

function encapsulationDirectory(id: string, digest: string) {
  const encoded = encodeURIComponent(id)
    .replace(/%[0-9A-F]{2}/g, (hexEscape) => hexEscape.toLowerCase())
    .replace(/[.!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return encoded.length > MAX_ENCODED_ID_LENGTH ? `${encoded.slice(0, MAX_ENCODED_ID_LENGTH)}-${digest}` : encoded;
}

const DEFAULT_CONFIG: Required<Omit<HashAndIdNTupleLayoutConfig, 'extensionName'>> = {
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
};

export class HashAndIdNTupleStorageLayout extends BuiltInLayout<typeof DEFAULT_CONFIG> {
  readonly name = '0003-hash-and-id-n-tuple-storage-layout';
  readonly description: string =
    'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
    ' These digests are then divided into N n-tuple segments,' +
    ' which are used to create nested paths under the OCFL storage root.' +
    ' Finally, the OCFL object identifier is percent-encoded to create a directory name for the OCFL object root.';

  constructor(config?: OcflExtensionConfig) {
    super(config, DEFAULT_CONFIG);
    checkNTupleParameters(this.parameters);
  }

  map(id: string): string {
    const digest = Hashing.digestSync(this.parameters.digestAlgorithm, id);
    return [...tupleSegments(digest, this.parameters), encapsulationDirectory(id, digest)].join(path.sep);
  }
}
