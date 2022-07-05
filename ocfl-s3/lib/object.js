//@ts-check

const ocfl = require('ocfl');

/**
 * OCFL Object backed by Amazon Simple Storage Service (S3)
 */
class OcflObjectS3 extends ocfl.Object {
  /**
   * @param {Object} config
   * @param {string} config.root - absolute path to the ocfl object root
   * @param {Object} config.aws - s3 parameters
   */
  constructor(config) {
    super(config);
  }

};

exports.Object = OcflObjectS3;