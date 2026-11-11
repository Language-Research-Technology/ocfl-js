import crypto from 'node:crypto';
import zlib from 'node:zlib';

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

interface HashState {
  update(data: Uint8Array): void;
  hex(): string;
}

function nativeHash(nodeName: string): () => HashState {
  return () => {
    const h = crypto.createHash(nodeName);
    let result: string | undefined;
    return {
      update: (d) => h.update(d),
      hex: () => {
        result ??= h.digest('hex');
        return result;
      },
    };
  };
}

function crc32Hash(): HashState {
  let crc = 0;
  return {
    update: (d) => {
      crc = zlib.crc32(d, crc);
    },
    hex: () => crc.toString(16).padStart(8, '0'),
  };
}

function sizeHash(): HashState {
  let size = 0;
  return {
    update: (d) => {
      size += d.byteLength;
    },
    hex: () => `${size}`,
  };
}

const ALGORITHMS = new Map<string, { hexLength: number; start: () => HashState }>([
  ['md5', { hexLength: 32, start: nativeHash('md5') }],
  ['sha1', { hexLength: 40, start: nativeHash('sha1') }],
  ['sha256', { hexLength: 64, start: nativeHash('sha256') }],
  ['sha512', { hexLength: 128, start: nativeHash('sha512') }],
  ['sha512/256', { hexLength: 64, start: nativeHash('sha512-256') }],
  ['blake2b-512', { hexLength: 128, start: nativeHash('blake2b512') }],
  ['crc32', { hexLength: 8, start: crc32Hash }],
  ['size', { hexLength: 1, start: sizeHash }],
]);

/**
 * Create a hasher instance for the given algorithm.
 */
function createHasher(algorithm: string): Hasher {
  const definition = ALGORITHMS.get(algorithm);
  if (!definition) {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
  const state = definition.start();
  return {
    update(data) {
      state.update(toBytes(data));
      return this;
    },
    digest: state.hex,
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
