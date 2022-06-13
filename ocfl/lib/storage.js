//@ts-check

class OcflStorage {
  static LAYOUT
  /**
   * Construct the path of the object root relative to the storage root.
   * The relative path is mapped from the object identifier using the algorithm defined in the chosen 
   * storage layout extension (specified in the options).
   * @param {*} id 
   */
  objectRoot(id) {
    return this.storageLayout.map(id);
  }
  /**
   * Get an existing object in the Storage or create a new one.
   * @param {string} id - A unique identifier for the OCFL Object, should be a URI
   */
  object(id) {
    return new this.constructor.ocflObjectClass({ id });
  }

  async has(id) {
    return await this.object(id).isValid();
  }
  async create() {

  }
  delete(id) {

  }
  remove(id) {
    return this.delete(id);
  }

};

/**
 * Abstract class implementing {@link OcflStorage}. 
 * This class provides common functionalities for the subclasses and 
 * at the same provide encapsulation emulating private and protected methods.
 * @implements {OcflStorage}
 */
class OcflStorageImpl extends OcflStorage {
  /**
   * 
   * @param {Object} options 
   * @param {boolean} [options.createOcflSpecText=false]
   */
  constructor(options) {
    super();
  }

}

module.exports = {
  OcflStorage,
  OcflStorageImpl
};