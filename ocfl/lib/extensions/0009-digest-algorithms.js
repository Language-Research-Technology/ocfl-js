//@ts-check

const {OcflExtension} = require("../extension");

/**
 * Notes: this implementation does nothing because the 0009 extension is implemented directly in the OcflDigest class.
 */
class DigestAlgorithm extends OcflExtension {
  static get NAME() { return '0009-digest-algorithms' }

  /**
   * 
   * @param {import('ocfl')} ocfl 
   */
  static async setup(ocfl) {}
}

module.exports = { DigestAlgorithm };