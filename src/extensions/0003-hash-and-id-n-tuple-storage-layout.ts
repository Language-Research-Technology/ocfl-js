import path from 'node:path';
import * as Hashing from '../digest.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';
import { checkNTupleParameters } from './n-tuple.ts';

/** Object directories named by their encoded id, nested under pieces of the id's digest. */
interface HashAndIdNTupleLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0003-hash-and-id-n-tuple-storage-layout';
  /** Algorithm used to hash the id. Defaults to `sha256`. */
  digestAlgorithm?: string;
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

const DefaultConfig: Required<Omit<HashAndIdNTupleLayoutConfig, 'extensionName'>> = {
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
};

class HashAndIdNTupleStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name = '0003-hash-and-id-n-tuple-storage-layout';
  readonly description: string =
    'OCFL object identifiers are hashed and encoded as lowercase hex strings.' +
    ' These digests are then divided into N n-tuple segments,' +
    ' which are used to create nested paths under the OCFL storage root.' +
    ' Finally, the OCFL object identifier is percent-encoded to create a directory name for the OCFL object root.';

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    checkNTupleParameters(this.parameters);
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

export { type HashAndIdNTupleLayoutConfig, HashAndIdNTupleStorageLayout };
