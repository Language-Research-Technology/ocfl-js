import crypto from 'node:crypto';

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
const ALGORITHMS = new Map<string, { hexLength: number; nodeName: string }>([
  ['md5', { hexLength: 32, nodeName: 'md5' }],
  ['sha1', { hexLength: 40, nodeName: 'sha1' }],
  ['sha256', { hexLength: 64, nodeName: 'sha256' }],
  ['sha512', { hexLength: 128, nodeName: 'sha512' }],
  ['sha512/256', { hexLength: 64, nodeName: 'sha512-256' }],
  ['blake2b-512', { hexLength: 128, nodeName: 'blake2b512' }],
]);

/**
 * Create a hasher instance for the given algorithm.
 */
function createHasher(algorithm: string): Hasher {
  const definition = ALGORITHMS.get(algorithm);
  if (!definition) {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
  const hash = crypto.createHash(definition.nodeName);
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

async function digest(algorithm: string, input: DataType | AsyncIterable<DataType>): Promise<string> {
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

function digestSync(algorithm: string, input: DataType): string {
  return createHasher(algorithm).update(input).digest();
}

function getHexDigestLength(algorithm: string): number {
  return ALGORITHMS.get(algorithm)?.hexLength ?? 0;
}

export { createHasher, digest, digestSync, getHexDigestLength, toBytes };
