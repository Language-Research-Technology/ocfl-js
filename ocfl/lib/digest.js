//@ts-check

const hashWasm = require('hash-wasm');
const {sha512_256} = require('js-sha512'); // fallback for sha512/256 algorithm, which is not included in hash-wasm
//const worker = require('node:worker_threads');
const { enumeration } = require('./enum.js');
const { testSymbol } = require('./utils.js');

const CONTENT = enumeration(['sha256', 'sha512']);
const FIXITY = enumeration(['sha256', 'sha512', 'md5', 'sha1', 'blake2b-512', 'blake2b-160', 'blake2b-256', 'blake2b-384', 'sha512/256', 'size', 'crc32']);

/**
 * @typedef {((outputType: "binary") => Uint8Array) & ((outputType?: "hex") => string)} IDigest
 * @typedef {((outputType: "binary") => {[key:string]: Uint8Array}) & ((outputType?: "hex") => {[key:string]: string})} IMultiDigest
 * @typedef {WritableStream & { update(data: IDataType): void, digest: IMultiDigest }} WritableStreamHash 
 */

/** 
 * @type { Object.<string, CommonHasher[]> }
 */
const hasherCache = {};
/** 
 * @type { Object.<string, CommonHasher> }
 */
const hasherSyncCache = {};
// for (let algo of FIXITY) {
//   algorithms[algo] = function () { return crypto.createHash(algo); }
// }

/** @type { WeakMap<CommonHasher, boolean>} */
const hasherPending = new WeakMap();

/** @type { {[key: string]: () => Promise<CommonHasher>} } */
const hasherFactory = {};

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

(function init() {
  for (const algo of FIXITY) {
    if (algo.startsWith('blake2b')) {
      const bits = parseInt(algo.split('-')[1]);
      registerHasherFactory(algo, async () => hashWasm.createBLAKE2b(bits));
    } else if (algo === 'sha512/256') {
      registerHasherFactory(algo, async () => {
        let h = sha512_256.create();
        /** @type {CommonHasher} */
        const hasher = {
          digestSize: 32,
          init() { h = sha512_256.create(); return this;},
          update(data) { h.update(/** @type {any} */(data)); return this },
          // @ts-ignore
          digest(encoding) {
            if (encoding === 'binary') return new Uint8Array(h.digest());
            else return h.hex();
          }
        };
        return hasher;
      });
    } else if (algo === 'size') {
      registerHasherFactory(algo, async () => {
        let encoder;
        let size = 0;
        /** @type {CommonHasher} */
        const hasher = {
          digestSize: 1,
          init() { 
            size = 0;
            encoder = new TextEncoder();
            return this;
          },
          update(data) {
            if (typeof data === 'string') size += encoder.encode(data).length;
            else size += data.byteLength;
            return this;
          },
          // @ts-ignore
          digest(encoding) {
            if (encoding === 'binary') return new Uint8Array(new BigUint64Array([BigInt(size)]).buffer);
            else return '' + size;
          }
        };
        return hasher;
      });
    } else {
      registerHasherFactory(algo, hashWasm['create' + algo.toUpperCase()]);
    }
  }
})();
// (async () => {
//   for (const name in hasherFactory) {
//     const factory = hasherFactory[name];
//     const h = await factory();
//     console.log(name);
//     console.log(h);
//     console.log(h.init().update('test').digest().length)
//   }
// })();
/**
 * Create a hasher instance for the given algorithm or get it from cache if available.
 * @param {string} algorithm 
 */
async function createHasher(algorithm) {
  const cacheArray = hasherCache[algorithm];
  let hash = (cacheArray ?? []).find(hasher => !hasherPending.get(hasher));
  if (!hash) {
    const factory = hasherFactory[algorithm];
    if (!factory) throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    hash = await factory();
    if (cacheArray) cacheArray.push(hash);
    else hasherCache[algorithm] = [hash];
  }
  hasherPending.set(hash, true);
  hash.init();
  return hash;
}

/**
 * Create a hasher instance for calculating multiple types of digest in one go.
 * @param {string|string[]} algorithms 
 */
async function createMultiHasher(algorithms) {
  const algoNames = Array.isArray(algorithms) ? (algorithms.length ? [...(new Set(algorithms))] : ['sha512']) : [algorithms];
  const hashes = await Promise.all(algoNames.map(createHasher));
  return /** @type { MultiHasher } */({
    update(data) {
      for (const hash of hashes) {
        hash.update(data);
      }
      return this;
    },
    digest(encoding) {
      const result = {};
      for (let i = 0; i < hashes.length; i++) {
        hasherPending.set(hashes[i], false);
        result[algoNames[i]] = hashes[i].digest(encoding);
      }
      return result;
    }
  });
}

/**
 * Create a hash instance that implements WritableStream.
 * @param {string|string[]} algorithm One or more digest algorithm names
 * @return {Promise<WritableStreamHash>}
 */
async function createStream(algorithm = 'sha512') {
  const hash = await createMultiHasher(algorithm);
  /** @type {any} */
  const ws = new WritableStream({
    write(chunk) {
      hash.update(chunk);
    }
  });
  ws.update = function (data) {
    hash.update(data);
  };
  ws.digest = function (encoding) {
    return hash.digest(encoding);
  }
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
  const hash = await createMultiHasher(algorithm);
  const { writableStrategy, readableStrategy } = options || {};
  //hash.setEncoding('hex');
  /** @type {any} */
  const ts = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      hash.update(chunk);
    }
  }, writableStrategy, readableStrategy);
  ts.digest = function (encoding) {
    return hash.digest(encoding);
  }
  return ts;
}

/**
 * 
 * @param {string|string[]} algorithm 
 * @param {IDataType | ReadableStream} input 
 * @return {Promise<{[key:string]: string}>}
 */
async function digest(algorithm, input) {
  if (input instanceof ReadableStream) {
    const hash = await createStream(algorithm);
    await input.pipeTo(hash);
    return hash.digest();
  } else {
    const hash = await createMultiHasher(algorithm);
    return hash.update(input).digest();
  }
}

async function initSync(algorithm) {
  if (!hasherSyncCache[algorithm]) {
    const factory = hasherFactory[algorithm];
    if (!factory) throw new Error(`Unsupported digest algorithm: ${algorithm}`);
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
  if (!hasher) throw new Error(`Hasher for algorithm ${algorithm} is not initialized. Please call and await initSync('${algorithm}') before calling this function.`);
  return hasher.init().update(input).digest();
}

const HEX_DIGEST_LENGTH = {
  'md5': 32,
  'sha1': 40,
  'sha256': 64,
  'sha512/256': 64,
  'sha512': 128,
  'blake2b-160': 40,
  'blake2b-256': 64,
  'blake2b-384': 96,
  'blake2b-512': 128,
  'crc32': 8,
  'size': 1
};

function getHexDigestLength(algorithm) {
  return HEX_DIGEST_LENGTH[algorithm] || 0;
}

const OcflDigest = {
  CONTENT,
  FIXITY,
  // algorithms,
  createStream, createStreamThrough, digest,
  registerHasherFactory, hasAlgorithm, getHexDigestLength,
  digestSync, initSync
};

module.exports = {
  OcflDigest,
  [testSymbol]: {
    hasherCache
  }
  // DIGEST,
  // DIGEST_FIXITY,
  // digestSync,
  // digestAsync,
  // digestFromStream,
  // digestStream,
  // HashThrough
};
