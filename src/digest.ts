import crypto from 'node:crypto';

/**
 * A fixity algorithm this library supports: the five every OCFL client must (spec E027), and `sha512/256` (extension 0009).
 * A hashed storage layout hashes object ids with one. The library doesn't read or write an inventory's `fixity` block.
 */
type FixityAlgorithm = 'md5' | 'sha1' | 'sha256' | 'sha512' | 'sha512/256' | 'blake2b-512';

/**
 * The algorithm of an OCFL object's digests, of its content and of its inventory: its inventory's `digestAlgorithm` (spec E025, E039).
 * Of the fixity algorithms, only these two may be an object's.
 */
type DigestAlgorithm = 'sha256' | 'sha512';

type DataType = string | ArrayBufferView | ArrayBufferLike;

interface Hasher {
  update: (data: DataType) => Hasher;
  digest: () => string;
}

const encoder = new TextEncoder();

/**
 * A string becomes its UTF-8 bytes; a view or buffer is wrapped, not copied.
 * @throws TypeError for anything else
 */
function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') {
    return encoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new TypeError(`Unsupported data type: ${Object.prototype.toString.call(data)}`);
}

/** Each algorithm by its OCFL name, with the name `node:crypto` knows it by */
const ALGORITHMS: Record<FixityAlgorithm, { hexLength: number; nodeName: string }> = {
  md5: { hexLength: 32, nodeName: 'md5' },
  sha1: { hexLength: 40, nodeName: 'sha1' },
  sha256: { hexLength: 64, nodeName: 'sha256' },
  sha512: { hexLength: 128, nodeName: 'sha512' },
  'sha512/256': { hexLength: 64, nodeName: 'sha512-256' },
  'blake2b-512': { hexLength: 128, nodeName: 'blake2b512' },
};

/** Whether `name` is a fixity algorithm this library supports, written exactly so */
function isFixityAlgorithm(name: string): name is FixityAlgorithm {
  return Object.hasOwn(ALGORITHMS, name);
}

/**
 * Create a hasher instance for the given algorithm.
 */
function createHasher(algorithm: FixityAlgorithm): Hasher {
  const hash = crypto.createHash(ALGORITHMS[algorithm].nodeName);
  let hex: string | undefined;
  return {
    update(data) {
      hash.update(toBytes(data));
      return this;
    },
    // node:crypto allows a hash to be finished only once
    digest() {
      hex ??= hash.digest('hex');
      return hex;
    },
  };
}

async function digest(algorithm: FixityAlgorithm, input: DataType | AsyncIterable<DataType>): Promise<string> {
  const hash = createHasher(algorithm);
  if (typeof input === 'object' && Symbol.asyncIterator in input) {
    for await (const chunk of input) {
      hash.update(chunk);
    }
  } else {
    hash.update(input);
  }
  return hash.digest();
}

function digestSync(algorithm: FixityAlgorithm, input: DataType): string {
  return createHasher(algorithm).update(input).digest();
}

/** The form digests are compared and written in: hex digests are case-insensitive, and the library writes them in lowercase */
function normaliseDigest(digest: string): string {
  return digest.toLowerCase();
}

function getHexDigestLength(algorithm: FixityAlgorithm): number {
  return ALGORITHMS[algorithm].hexLength;
}

export { createHasher, type DigestAlgorithm, digest, digestSync, type FixityAlgorithm, getHexDigestLength, isFixityAlgorithm, normaliseDigest, toBytes };
