const fs = require('fs');

const helpers = {
  getFile: async (filePath) => fs.promises.readFile(filePath, 'utf8')
};

const storeConfig = { };

module.exports = {
  storeConfig,
  helpers,
};
