//const {} = require('./object');
//const digest = require('./digest');

class OcflExtensionRegistry {
  #object = {};
  #storage = {};
  /**
   * Get an object-level extension
   * @param {string} name - A registered extension name
   */
  object(name) {
    return this.#object[name];
  }
  /**
   * Get an storage-level extension
   * @param {string} name - A registered extension name
   */
  storage(name) {
    return this.#storage[name];
  }
  /**
   * Register an extension
   * @param {OcflExtension} extension
   */
  register(extension) {
    if (extension.forObject) {
      if (this.#object[extension.name]) throw new Error(`Extension ${extension.name} already registered.`);
      this.#object[extension.name] = extension;
    }
    if (extension.forStorage) {
      if (this.#storage[extension.name]) throw new Error(`Extension ${extension.name} already registered.`);
      this.#storage[extension.name] = extension;
    }
    extension.setup();
  }
}

class OcflExtension {
  static EXTENSION_NAME = '0000-example-extension';
  static create(config) { return new this(); }
  constructor() {}
  get name() { return /** @type {typeof OcflExtension}*/(this.constructor).EXTENSION_NAME }
  get minOcflVersion() { return "1.0" }
  get version() { return "1.0" }

}

module.exports = {
  //ocflExtensionRegistry: new OcflExtensionRegistry(),
  OcflExtension
}
