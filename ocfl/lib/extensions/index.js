
module.exports = {
  ...require('./0001-digest-algorithms'),
  ...require('./0002-flat-direct-storage-layout'),
  ...require('./0003-hash-and-id-n-tuple-storage-layout'),
  ...require('./0004-hashed-n-tuple-storage-layout'),
//  ...require('./0005-mutable-head'),
  ...require('./0006-flat-omit-prefix-storage-layout'),
  ...require('./0007-n-tuple-omit-prefix-storage-layout'),
  ...require('./000N-path-direct-storage-layout')
  //...require('./0008-schema-registry')
};
//const { DigestAlgorithm } = require('./0001-digest-algorithms.js');
