//@ts-check

//const hasha = require("hasha");
//const crypto = require("crypto");
const hashWasm = require('hash-wasm');
const fs = require("fs");
const stream = require("stream/promises");
//const worker = require('node:worker_threads');
const { enumeration } = require('./enum.js');
const { testSymbol } = require('./utils.js');
//const { Transform } = require('stream');

const CONTENT = enumeration(['sha256', 'sha512']);
const FIXITY = enumeration(['sha256', 'sha512', 'md5', 'sha1', 'blake2b-512']);

/**
 * A pass through stream that pass data as it is and calculate the digest as data pass through.
 */
// class HashThrough extends Transform {
//   constructor(hash, streamOptions) {
//     super(streamOptions);
//     this.hash = hash;
//   }
//   _transform(chunk, encoding, cb) {
//     try {
//       this.hash.update(chunk, encoding);
//       cb(null, chunk);
//     } catch (err) {
//       cb(err)
//     }
//   }
//   digest(encoding) {
//     return this.hash.digest(encoding || 'hex');
//   }
// }

/**
 * @type { Object.<string, import('hash-wasm').IHasher[]>}
 */
const algorithms = {};
// for (let algo of FIXITY) {
//   algorithms[algo] = function () { return crypto.createHash(algo); }
// }

/**
 * 
 * @param {string} algorithm 
 */
async function createHash(algorithm) {
  let hash = algorithms[algorithm]?.pop();
  if (!hash) {
    let hp;
    if (algorithm === 'blake2b-512') hp = hashWasm.createBLAKE2b(512);
    else hp = hashWasm['create' + algorithm.toUpperCase()]?.();
    if (!hp) throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    hash = await hp;
  }
  if (hash) {
    return hash.init();
  }
}

function cacheHash(algorithm, hashInstance) {
  const a = algorithms[algorithm] ??= [];
  if (!a.includes(hashInstance)) a.push(hashInstance);
  return hashInstance;
}

/** 
 * @typedef {import('hash-wasm').IDataType} IDataType
 * @typedef {((outputType: "binary") => Uint8Array) & ((outputType?: "hex") => string)} IDigest
 * @typedef {WritableStream & { update(data: IDataType): void, digest: IDigest }} WritableStreamHash 
 * */
/**
 * Create a hash instance that implements WritableStream.
 * @param {string} algorithm 
 * @return {Promise<WritableStreamHash>}
 */
async function createStream(algorithm) {
  const hash = await createHash(algorithm || 'sha512');
  /** @type {any} */
  const ws = new WritableStream({
    write(chunk) {
      hash.update(chunk);
    }
  });
  ws.update = (data) => hash.update(data);
  ws.digest = (encoding) => cacheHash(algorithm, hash).digest(encoding);
  return ws;
}

/** @typedef {TransformStream & { digest: IDigest }} StreamThroughHash */
/**
 * Create a pass through stream that pass data as it is and calculate the digest as data pass through.
 * @param {string} [algorithm] 
 * @param {object} [options]
 * @return {Promise<StreamThroughHash>}
 */
async function createStreamThrough(algorithm = 'sha512', options) {
  const hash = await createHash(algorithm);
  const { writableStrategy, readableStrategy } = options || {};
  //hash.setEncoding('hex');
  /** @type {any} */
  const ts = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      hash.update(chunk);
    }
  }, writableStrategy, readableStrategy);
  ts.digest = (encoding) => cacheHash(algorithm, hash).digest(encoding);
  return ts;
}

/**
 * Before using this function, make sure to call createHash and cacheHash first to create and cache hash instances.
 * @param {string} algorithm 
 * @param {IDataType} input 
 * @return {string}
 */
function digestSync(algorithm, input) {
  const hash = algorithms[algorithm || 'sha512']?.[0];
  if (hash) {
    hash.init();
    hash.update(input);
    return hash.digest();
  }
}

/**
 * 
 * @param {string} algorithm 
 * @param {IDataType | ReadableStream} input 
 * @return {Promise<string>}
 */
async function digest(algorithm, input) {
  if (input instanceof ReadableStream) {
    let hash = await createStream(algorithm);
    await input.pipeTo(hash);
    return hash.digest();
  } else {
    if (algorithm === 'blake2b-512') return hashWasm.blake2b(input, 512);
    else return hashWasm[algorithm]?.(input);
  }
}

async function load() {
  for (const algo of FIXITY) {
    if (!algorithms[algo]?.length) {
      const hash = await createHash(algo);
      cacheHash(algo, hash);
    }
  }
}

const OcflDigest = {
  CONTENT,
  FIXITY,
  // algorithms,
  createStream, createStreamThrough,
  digest, digestSync,
  cacheHash, createHash, load
};

module.exports = {
  OcflDigest,
  [testSymbol]: {
    algorithms
  }
  // DIGEST,
  // DIGEST_FIXITY,
  // digestSync,
  // digestAsync,
  // digestFromStream,
  // digestStream,
  // HashThrough
};
