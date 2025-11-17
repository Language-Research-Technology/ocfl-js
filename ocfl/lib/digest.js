//@ts-check

const hashWasm = require('hash-wasm');
//const worker = require('node:worker_threads');
const { enumeration } = require('./enum.js');
const { testSymbol } = require('./utils.js');

const CONTENT = enumeration(['sha256', 'sha512']);
const FIXITY = enumeration(['sha256', 'sha512', 'md5', 'sha1', 'blake2b-512']);

/**
 * @typedef { import('hash-wasm').IHasher } IHasher
 * @typedef {import('hash-wasm').IDataType} IDataType
 * @typedef {((outputType: "binary") => Uint8Array) & ((outputType?: "hex") => string)} IDigest
 * @typedef {((outputType: "binary") => {[key:string]: Uint8Array}) & ((outputType?: "hex") => {[key:string]: string})} IMultiDigest
 * @typedef {WritableStream & { update(data: IDataType): void, digest: IMultiDigest }} WritableStreamHash 
 */

/** 
 * @type { Object.<string, CommonHasher[]> }
 */
const hasherCache = {};
// for (let algo of FIXITY) {
//   algorithms[algo] = function () { return crypto.createHash(algo); }
// }

/** @type { WeakMap<CommonHasher, boolean>} */
const hasherPending = new WeakMap();

/** @type { {[key: string]: () => Promise<IHasher>} } */
const hasherFactory = {};
function registerHasherFactory(name, factory) {
  if (typeof factory === 'function') {
    hasherFactory[name] = factory;
  }
}

function hasAlgorithm(name) {
  return name in hasherFactory;
}

(function init() {
  for (let algo of FIXITY) {
    if (algo === 'blake2b-512') {
      registerHasherFactory(algo, async () => hashWasm.createBLAKE2b(512));
    } else {
      registerHasherFactory(algo, hashWasm['create' + algo.toUpperCase()]);
    }
  }
})();

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

const OcflDigest = {
  CONTENT,
  FIXITY,
  // algorithms,
  createStream, createStreamThrough, digest,
  registerHasherFactory, hasAlgorithm
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
