import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { enumeration } from './enum.ts';
import type { CommonHasher, IDataType, MultiHasher } from './types.ts';

const CONTENT = enumeration(['sha256', 'sha512']);
const FIXITY = enumeration(['sha256', 'sha512', 'md5', 'sha1', 'blake2b-512', 'sha512/256', 'size', 'crc32']);

/** OCFL algorithm name to node:crypto name */
const NATIVE = {
  md5: 'md5',
  sha1: 'sha1',
  sha256: 'sha256',
  sha512: 'sha512',
  'sha512/256': 'sha512-256',
  'blake2b-512': 'blake2b512',
};

type Digest = CommonHasher['digest'];
type MultiDigest = MultiHasher['digest'];
type WritableStreamHasher = WritableStream & { update(data: IDataType): void; digest: Digest };
type WritableStreamMultiHasher = WritableStream & { update(data: IDataType): void; digest: MultiDigest };
type StreamThroughHash = TransformStream & { digest: MultiDigest };
type StreamThroughOptions = { writableStrategy?: QueuingStrategy; readableStrategy?: QueuingStrategy };

function toBytes(data: IDataType): string | Uint8Array {
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

function hasher(digestSize: number, start: () => HashState): CommonHasher {
  let state = start();
  return {
    digestSize,
    init() {
      state = start();
      return this;
    },
    update(data) {
      state.update(toBytes(data));
      return this;
    },
    digest: ((encoding?: 'binary' | 'hex') => (encoding === 'binary' ? state.digest() : state.hex())) as Digest,
  };
}

const hasherFactory: { [key: string]: () => Promise<CommonHasher> } = {};
const hasherSyncCache: { [key: string]: CommonHasher } = {};

/**
 * Register a hash algorithm and it's factory function.
 */
function registerHasherFactory(name: string, factory: () => Promise<CommonHasher>) {
  if (typeof factory === 'function') {
    hasherFactory[name] = factory;
  }
}

function hasAlgorithm(name: string) {
  return name in hasherFactory;
}

for (const [algo, nativeName] of Object.entries(NATIVE)) {
  const digestSize = crypto.createHash(nativeName).digest().length;
  registerHasherFactory(algo, async () =>
    hasher(digestSize, () => {
      const h = crypto.createHash(nativeName);
      let result: Buffer | undefined;
      const final = () => {
        result ??= h.digest();
        return result;
      };
      return { update: (d) => h.update(d), digest: () => new Uint8Array(final()), hex: () => final().toString('hex') };
    }),
  );
}

registerHasherFactory('crc32', async () =>
  hasher(4, () => {
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
  }),
);

registerHasherFactory('size', async () =>
  hasher(8, () => {
    let size = 0;
    return {
      update: (d) => {
        size += typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength;
      },
      digest: () => new Uint8Array(new BigUint64Array([BigInt(size)]).buffer),
      hex: () => `${size}`,
    };
  }),
);

/**
 * Create a hasher instance for the given algorithm.
 */
async function createHasher(algorithm: string): Promise<CommonHasher> {
  const factory = hasherFactory[algorithm];
  if (!factory) {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
  return (await factory()).init();
}

/**
 * Create a hasher instance for calculating multiple types of digest in one go.
 */
async function createMultiHasher(algorithms: string | string[]): Promise<MultiHasher> {
  const algoNames = Array.isArray(algorithms) ? (algorithms.length ? [...new Set(algorithms)] : ['sha512']) : [algorithms];
  const hashers = await Promise.all(algoNames.map(async (name) => [name, await createHasher(name)] as const));
  const multiHasher: MultiHasher = {
    multi: true,
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

function createAnyHasher(algorithm: string | string[]): Promise<CommonHasher | MultiHasher> {
  return Array.isArray(algorithm) ? createMultiHasher(algorithm) : createHasher(algorithm);
}

/**
 * Create a hash instance that implements WritableStream.
 * @param algorithm One or more digest algorithm names
 */
async function createStream(algorithm?: string): Promise<WritableStreamHasher>;
async function createStream(algorithm: string[]): Promise<WritableStreamMultiHasher>;
async function createStream(algorithm: string | string[] = 'sha512'): Promise<WritableStreamHasher | WritableStreamMultiHasher> {
  const hash = await createAnyHasher(algorithm);
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
async function createStreamThrough(algorithm: string | string[] = 'sha512', options?: StreamThroughOptions): Promise<StreamThroughHash> {
  const hash = await createAnyHasher(algorithm);
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

async function digest(algorithm: string[], input: IDataType | ReadableStream): Promise<{ [key: string]: string }>;
async function digest(algorithm: string, input: IDataType | ReadableStream): Promise<string>;
async function digest(algorithm: string | string[], input: IDataType | ReadableStream): Promise<string | { [key: string]: string }> {
  if (input instanceof ReadableStream) {
    const hash = await createStream(algorithm as string);
    await input.pipeTo(hash);
    return hash.digest();
  }
  const hash = await createAnyHasher(algorithm);
  return hash.update(input).digest();
}

async function initSync(algorithm: string) {
  if (!hasherSyncCache[algorithm]) {
    const factory = hasherFactory[algorithm];
    if (!factory) {
      throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    }
    hasherSyncCache[algorithm] = await factory();
  }
}

/**
 * For this sync function to work correctly, it requires a call to initSync() to be awaited for each algorithm before calling this function.
 */
function digestSync(algorithm: string, input: IDataType): string {
  const hasher = hasherSyncCache[algorithm];
  if (!hasher) {
    throw new Error(`Hasher for algorithm ${algorithm} is not initialized. Please call and await initSync('${algorithm}') before calling this function.`);
  }
  return hasher.init().update(input).digest();
}

const HEX_DIGEST_LENGTH: { [algorithm: string]: number } = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  'sha512/256': 64,
  sha512: 128,
  'blake2b-512': 128,
  crc32: 8,
  size: 1,
};

function getHexDigestLength(algorithm: string) {
  return HEX_DIGEST_LENGTH[algorithm] || 0;
}

const OcflDigest = {
  CONTENT,
  FIXITY,
  createStream,
  createStreamThrough,
  digest,
  registerHasherFactory,
  hasAlgorithm,
  getHexDigestLength,
  digestSync,
  initSync,
};

export { OcflDigest };
