//@ts-check

exports.Storage = class Storage {
  /**
   * 
   * @param {Object} options 
   * @param {boolean} [options.createOcflSpecText=false]
   */
  constructor(options) {

  }
  delete(id) {

  }
  remove(id) {
    return this.delete(id);
  }
};

exports.createStorage = (config) => createProxy(new OcflStorageFs(config));
