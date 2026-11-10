import crypto from 'node:crypto';
import zlib from 'node:zlib';

type DataType = string | ArrayBufferLike | Uint8Array | Uint16Array | Uint32Array;

interface Hasher {
  update: (data: DataType) => Hasher;
  digest: {
    (outputType: 'binary'): Uint8Array;
    (outputType?: 'hex'): string;
  };
}

interface MultiHasher {
  update: (data: DataType) => MultiHasher;
  digest: {
    (outputType: 'binary'): { [key: string]: Uint8Array };
    (outputType?: 'hex'): { [key: string]: string };
  };
}

const CONTENT = ['sha256', 'sha512'] as const;
type ContentAlgorithm = (typeof CONTENT)[number];

type Digest = Hasher['digest'];
type MultiDigest = MultiHasher['digest'];
type WritableStreamHasher = WritableStream & { update(data: DataType): void; digest: Digest };
type WritableStreamMultiHasher = WritableStream & { update(data: DataType): void; digest: MultiDigest };
type StreamThroughHash = TransformStream & { digest: MultiDigest };
type StreamThroughOptions = { writableStrategy?: QueuingStrategy; readableStrategy?: QueuingStrategy };

function toBytes(data: DataType): string | Uint8Array {
  if (typeof data === 'string' || data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

interface HashState {
  update(data: string | Uint8Array): void;
  digest(): Uint8Array;
  hex(): string;
}

function nativeHash(nodeName: string): () => HashState {
  return () => {
    const h = crypto.createHash(nodeName);
    let result: Buffer | undefined;
    const final = () => {
      result ??= h.digest();
      return result;
    };
    return { update: (d) => h.update(d), digest: () => new Uint8Array(final()), hex: () => final().toString('hex') };
  };
}

function crc32Hash(): HashState {
  let crc = 0;
  return {
    update: (d) => {
      crc = zlib.crc32(d, crc);
    },
    digest: () => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, crc);
      return b;
    },
    hex: () => crc.toString(16).padStart(8, '0'),
  };
}

function sizeHash(): HashState {
  let size = 0;
  return {
    update: (d) => {
      size += typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength;
    },
    digest: () => new Uint8Array(new BigUint64Array([BigInt(size)]).buffer),
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
    digest: ((encoding?: 'binary' | 'hex') => (encoding === 'binary' ? state.digest() : state.hex())) as Digest,
  };
}

/**
 * Create a hasher instance for calculating multiple types of digest in one go.
 */
function createMultiHasher(algorithms: string | string[]): MultiHasher {
  const algoNames = Array.isArray(algorithms) ? (algorithms.length ? [...new Set(algorithms)] : ['sha512']) : [algorithms];
  const hashers = algoNames.map((name) => [name, createHasher(name)] as const);
  const multiHasher: MultiHasher = {
    update(data) {
      for (const [, hash] of hashers) {
        hash.update(data);
      }
      return this;
    },
    digest: ((encoding?: 'binary' | 'hex') => {
      const result: { [key: string]: string | Uint8Array } = {};
      for (const [name, hash] of hashers) {
        result[name] = hash.digest(encoding as 'hex');
      }
      return result;
    }) as MultiDigest,
  };
  return multiHasher;
}

function createAnyHasher(algorithm: string | string[]): Hasher | MultiHasher {
  return Array.isArray(algorithm) ? createMultiHasher(algorithm) : createHasher(algorithm);
}

/**
 * Create a hash instance that implements WritableStream.
 * @param algorithm One or more digest algorithm names
 */
function createStream(algorithm?: string): WritableStreamHasher;
function createStream(algorithm: string[]): WritableStreamMultiHasher;
function createStream(algorithm: string | string[] = 'sha512'): WritableStreamHasher | WritableStreamMultiHasher {
  const hash = createAnyHasher(algorithm);
  const ws = new WritableStream({
    write(chunk) {
      hash.update(chunk);
    },
  }) as WritableStreamHasher & WritableStreamMultiHasher;
  ws.update = (data) => {
    hash.update(data);
  };
  ws.digest = ((encoding?: 'binary' | 'hex') => hash.digest(encoding as 'hex')) as Digest & MultiDigest;
  return ws;
}

/**
 * Create a pass through stream that pass data as it is and calculate the digest as data pass through.
 */
function createStreamThrough(algorithm: string | string[] = 'sha512', options?: StreamThroughOptions): StreamThroughHash {
  const hash = createAnyHasher(algorithm);
  const { writableStrategy, readableStrategy } = options || {};
  const ts = new TransformStream(
    {
      transform(chunk, controller) {
        controller.enqueue(chunk);
        hash.update(chunk);
      },
    },
    writableStrategy,
    readableStrategy,
  ) as StreamThroughHash;
  ts.digest = ((encoding?: 'binary' | 'hex') => hash.digest(encoding as 'hex')) as MultiDigest;
  return ts;
}

async function digest(algorithm: string[], input: DataType | ReadableStream): Promise<{ [key: string]: string }>;
async function digest(algorithm: string, input: DataType | ReadableStream): Promise<string>;
async function digest(algorithm: string | string[], input: DataType | ReadableStream): Promise<string | { [key: string]: string }> {
  if (input instanceof ReadableStream) {
    const hash = createStream(algorithm as string);
    await input.pipeTo(hash);
    return hash.digest();
  }
  return createAnyHasher(algorithm).update(input).digest();
}

function digestSync(algorithm: string, input: DataType): string {
  return createHasher(algorithm).update(input).digest();
}

function getHexDigestLength(algorithm: string) {
  return ALGORITHMS.get(algorithm)?.hexLength ?? 0;
}

const Hashing = {
  createStream,
  createStreamThrough,
  digest,
  getHexDigestLength,
  digestSync,
};

export { type ContentAlgorithm, Hashing };
