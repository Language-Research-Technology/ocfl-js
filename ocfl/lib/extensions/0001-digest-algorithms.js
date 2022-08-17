//@ts-check

const {OcflExtension} = require("../extension");
const crypto = require('crypto');
const blake2 = require('blake2');

class DigestAlgorithm extends OcflExtension {
  static get NAME() { return '0001-digest-algorithms' }

  // static create() {
  //   if (!instance) instance = new DigestAlgorithm();
  //   return instance;
  // }
  /**
   * 
   * @param {import('ocfl')} ocfl 
   */
  static setup(ocfl) {
    let {OcflDigest} = ocfl;
    let { FIXITY } = OcflDigest;
    class FIXITY_EX extends FIXITY {
      static blake2b160 = new this('blake2b-160');
      static blake2b256 = new this('blake2b-256');
      static blake2b384 = new this('blake2b-384');
      static ['sha512-256'] = new this('sha512/256');
    };
    OcflDigest.FIXITY = FIXITY_EX;
    //console.log(OcflDigest.FIXITY);
    for (let len of [160, 256, 384]) {
      OcflDigest.algorithms['blake2b-' + len] = function() { 
        return blake2.createHash('blake2b', {digestLength: len/8}); 
      }
    }
    OcflDigest.algorithms['sha512/256'] = function() { 
      return crypto.createHash('sha512-256'); 
    }
    //console.log(OcflDigest.algorithms);
  }
}

module.exports = { DigestAlgorithm };