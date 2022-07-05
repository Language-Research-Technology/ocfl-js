//@ts-check

//const hasha = require("hasha");
const crypto = require("crypto");
const fs = require("fs");
const stream = require("stream/promises");
//const worker = require('node:worker_threads');
const { Enum } = require('./enum.js');
const { Transform } = require('stream');

/**
 */
class CONTENT extends Enum {
  static sha256 = new this('sha256');
  static sha512 = new this('sha512');
};

class FIXITY extends Enum {
  static sha256 = new this('sha256');
  static sha512 = new this('sha512');
  static md5 = new this('md5');
  static sha1 = new this('sha1');
  static blake2b512 = new this('blake2b-512');
};

/**
 * A pass through stream that pass data as it is and calculate the digest as data pass through.
 */
class HashThrough extends Transform {
  constructor(hash, streamOptions) {
    super(streamOptions);
    this.hash = hash;
  }
  _transform(chunk, encoding, cb) {
    try {
      this.hash.update(chunk, encoding);
      cb(null, chunk);
    } catch (err) {
      cb(err)
    }
  }
  digest(encoding) {
    return this.hash.digest(encoding || 'hex');
  }
}

/**
 * @type { Object.<string, function():crypto.Hash>}
 */
let algorithms = {};
for (let algo of FIXITY) {
  algorithms[algo.value] = function () { return crypto.createHash(algo.name); }
}

/**
 * 
 * @param {string} algorithm 
 */
function createStream(algorithm) {
  const hash = algorithms[algorithm || 'sha512']();
  hash.setEncoding('hex');
  return hash;
}

/**
 * 
 * @param {string} algorithm 
 */
function createStreamThrough(algorithm, options) {
  const hash = algorithms[algorithm || 'sha512']();
  hash.setEncoding('hex');
  return new HashThrough(hash, options);
}

/**
 * 
 * @param {string} algorithm 
 * @param {Buffer | string | Array<Buffer | string>} input 
 * @return {string}
 */
function digestSync(algorithm, input) {
  const hash = algorithms[algorithm || 'sha512']();
  let inputs = Array.isArray(input) ? input : [input];
  for (let chunk of inputs) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * 
 * @param {string} algorithm 
 * @param {Buffer | string | Array<Buffer | string>} input 
 */
async function digestAsync(algorithm, input) {
  return digestSync(algorithm, input);
}

/**
 * 
 * @param {string} algorithm 
 * @param {NodeJS.ReadableStream} input 
 */
async function digestFromStream(algorithm, input) {
  let hash = algorithms[algorithm]();
  await stream.pipeline(input, hash);
  return hash.digest('hex');
}

/**
 * 
 * @param {string} algorithm 
 * @param {string} filePath 
 */
async function digestFromFile(algorithm, filePath) {
  return await digestFromStream(algorithm, fs.createReadStream(filePath));
}

const OcflDigest = {
  CONTENT,
  FIXITY,
  algorithms,
  createStream, createStreamThrough,
  digestAsync, digestSync,
  digestFromStream, digestFromFile
};

module.exports = {
  OcflDigest
  // DIGEST,
  // DIGEST_FIXITY,
  // digestSync,
  // digestAsync,
  // digestFromStream,
  // digestFromFile,
  // digestStream,
  // HashThrough
};
