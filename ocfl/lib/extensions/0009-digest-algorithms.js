//@ts-check

const {OcflExtension} = require("../extension");
const crypto = require('crypto');
const { createBLAKE2b } = require('hash-wasm');
const { enumeration } = require("../enum");

class DigestAlgorithm extends OcflExtension {
  static get NAME() { return '0009-digest-algorithms' }

  // static create() {
  //   if (!instance) instance = new DigestAlgorithm();
  //   return instance;
  // }
  /**
   * 
   * @param {import('ocfl')} ocfl 
   */
  static async setup(ocfl) {
    const {OcflDigest} = ocfl;
    const { FIXITY } = OcflDigest;
    const FIXITY_EX = enumeration(['blake2b-160', 'blake2b-256', 'blake2b-384', 'sha512-256', 'size', 'crc32']);
    //OcflDigest.FIXITY = FIXITY_EX;
    //console.log(OcflDigest.FIXITY);
    const blake2b = Object.fromEntries(await Promise.all([160, 256, 384].map(bits => [bits, createBLAKE2b(bits)])));
    
    for (let bits of [160, 256, 384]) {
      OcflDigest.algorithms['blake2b-' + bits] = function() { 
        //return blake2.createHash('blake2b', {digestLength: len/8}); 
        blake2b[bits].init();
        return blake2b[bits];
      }
    }
    OcflDigest.algorithms['sha512/256'] = function() { 
      return crypto.createHash('sha512-256'); 
    }
    //console.log(OcflDigest.algorithms);
    // todo: handle size and crc32 
  }
}

module.exports = { DigestAlgorithm };