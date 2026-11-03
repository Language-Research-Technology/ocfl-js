//@ts-check

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { enumeration } = require('./enum.js');

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

/**
 * @typedef {((outputType: "binary") => Uint8Array) & ((outputType?: "hex") => string)} IDigest
 * @typedef {((outputType: "binary") => {[key:string]: Uint8Array}) & ((outputType?: "hex") => {[key:string]: string})} IMultiDigest
 * @typedef {WritableStream & { update(data: IDataType): void, digest: IDigest }} WritableStreamHasher
 * @typedef {WritableStream & { update(data: IDataType): void, digest: IMultiDigest }} WritableStreamMultiHasher
 */

/**
 * @param {IDataType} data
 * @returns {string | Uint8Array}
 */
function toBytes(data) {
  if (typeof data === 'string' || data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * @param {number} digestSize
 * @param {() => { update(data: string | Uint8Array): void, digest(): Uint8Array, hex(): string }} start
 * @returns {CommonHasher}
 */
function hasher(digestSize, start) {
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
    // @ts-expect-error overloaded return type
    digest(encoding) {
      return encoding === 'binary' ? state.digest() : state.hex();
    },
  };
}

/** @type { {[key: string]: () => Promise<CommonHasher>} } */
const hasherFactory = {};
/** @type { Object.<string, CommonHasher> } */
const hasherSyncCache = {};

/**
 * Register a hash algorithm and it's factory function.
 * @param {string} name
 * @param {() => Promise<CommonHasher>} factory
 */
function registerHasherFactory(name, factory) {
  if (typeof factory === 'function') {
    hasherFactory[name] = factory;
  }
}

function hasAlgorithm(name) {
  return name in hasherFactory;
}

for (const [algo, nativeName] of Object.entries(NATIVE)) {
  const digestSize = crypto.createHash(nativeName).digest().length;
  registerHasherFactory(algo, async () =>
    hasher(digestSize, () => {
      const h = crypto.createHash(nativeName);
      let result;
      const final = () => (result ??= h.digest());
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
 * @param {string} algorithm
 */
async function createHasher(algorithm) {
  const factory = hasherFactory[algorithm];
  if (!factory) {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
  return (await factory()).init();
}

/**
 * Create a hasher instance for calculating multiple types of digest in one go.
 * @param {string|string[]} algorithms
 */
async function createMultiHasher(algorithms) {
  const algoNames = Array.isArray(algorithms) ? (algorithms.length ? [...new Set(algorithms)] : ['sha512']) : [algorithms];
  const hashers = await Promise.all(algoNames.map(createHasher));
  return /** @type { MultiHasher } */ ({
    multi: true,
    update(data) {
      for (const hash of hashers) {
        hash.update(data);
      }
      return this;
    },
    digest(encoding) {
      const result = {};
      for (let i = 0; i < hashers.length; i++) {
        result[algoNames[i]] = hashers[i].digest(encoding);
      }
      return result;
    },
  });
}

/**
 * Create a hash instance that implements WritableStream.
 * @overload
 * @param {string} algorithm One or more digest algorithm names
 * @return {Promise<WritableStreamHasher>}
 */
/**
 * @overload
 * @param {string[]} algorithm One or more digest algorithm names
 * @return {Promise<WritableStreamMultiHasher>}
 */
async function createStream(algorithm = 'sha512') {
  const hash = await (Array.isArray(algorithm) ? createMultiHasher(algorithm) : createHasher(algorithm));
  /** @type {any} */
  const ws = new WritableStream({
    write(chunk) {
      hash.update(chunk);
    },
  });
  ws.update = (data) => {
    hash.update(data);
  };
  ws.digest = (encoding) => hash.digest(encoding);
  return ws;
}

/** @typedef {TransformStream & { digest: IMultiDigest }} StreamThroughHash */
/**
 * Create a pass through stream that pass data as it is and calculate the digest as data pass through.
 * @param {string|string[]} [algorithm]
 * @param {object} [options]
 * @return {Promise<StreamThroughHash>}
 */
async function createStreamThrough(algorithm = 'sha512', options) {
  const hash = await (Array.isArray(algorithm) ? createMultiHasher(algorithm) : createHasher(algorithm));
  const { writableStrategy, readableStrategy } = options || {};
  /** @type {any} */
  const ts = new TransformStream(
    {
      transform(chunk, controller) {
        controller.enqueue(chunk);
        hash.update(chunk);
      },
    },
    writableStrategy,
    readableStrategy,
  );
  ts.digest = (encoding) => hash.digest(encoding);
  return ts;
}

/**
 *
 * @overload
 * @param {string[]} algorithm
 * @param {IDataType | ReadableStream} input
 * @return {Promise<{[key:string]: string}>}
 */
/**
 * @overload
 * @param {string} algorithm
 * @param {IDataType | ReadableStream} input
 * @return {Promise<string>}
 */
async function digest(algorithm, input) {
  if (input instanceof ReadableStream) {
    const hash = await createStream(algorithm);
    await input.pipeTo(hash);
    return hash.digest();
  } else {
    const hash = await (Array.isArray(algorithm) ? createMultiHasher(algorithm) : createHasher(algorithm));
    return hash.update(input).digest();
  }
}

async function initSync(algorithm) {
  if (!hasherSyncCache[algorithm]) {
    const factory = hasherFactory[algorithm];
    if (!factory) {
      throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    }
    const hasher = await factory();
    hasherSyncCache[algorithm] = hasher;
  }
}

/**
 * For this sync function to work correctly, it requires a call to initSync() to be awaited for each algorithm before calling this function.
 * @param {string} algorithm
 * @param {IDataType} input
 */
function digestSync(algorithm, input) {
  const hasher = hasherSyncCache[algorithm];
  if (!hasher) {
    throw new Error(`Hasher for algorithm ${algorithm} is not initialized. Please call and await initSync('${algorithm}') before calling this function.`);
  }
  return hasher.init().update(input).digest();
}

const HEX_DIGEST_LENGTH = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  'sha512/256': 64,
  sha512: 128,
  'blake2b-512': 128,
  crc32: 8,
  size: 1,
};

function getHexDigestLength(algorithm) {
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

module.exports = { OcflDigest };
