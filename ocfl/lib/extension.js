//const {} = require('./object');
//const digest = require('./digest');

const { NotImplementedError } = require("./error");

/** Index by Registered extension name */
const extensionByName = {};
/** Index by extension class name */
const extensionByClassName = {};
/** @type {Object.<string, typeof OcflStorageLayout>} */
const storageLayout = {};

/** @typedef {{ extensionName?: string;[key: string]: any; }} OcflExtensionConfig */

// class OcflExtensionConfig {
//   /** User defined config */
//   definedConfig;
//   constructor(config) {
//     this.definedConfig = config;
//   }
  
// }

/**
 * @template {{}} C
 */
class OcflExtension {
  static #object = {};
  static #storage = {};
  
  /**
   * Get an object-level extension
   * @param {string} name - A registered extension name
   */
  static object(name) {
    return this.#object[name];
  }
  /**
   * Get an storage-level extension
   * @param {string} name - A registered extension name
   */
  static storage(name) {
    return this.#storage[name];
  }

  /** List all registered extension classes */
  static get classes() {
    return Object.values(extensionByName);
  }

  /**
   * Find a registered extension with the specified name
   * @param {string} name - extension class name or registered extension name
   * @return {typeof OcflExtension} - the extension class
   */
  static class(name) {
    return extensionByName[name] || extensionByClassName[name];
  }

  /**
   * Register an extension
   * @param {typeof OcflExtension} extensionClass 
   */
  static register(extensionClass = this) {
    let name = extensionClass.NAME;
    extensionByName[name] = extensionClass;
    extensionByClassName[extensionClass.name] = extensionClass;
    // if (extensionClass.forObject) {
    //   if (this.#object[name]) throw new Error(`Extension ${name} already registered.`);
    //   this.#object[name] = extensionClass;
    // }
    // if (extensionClass.forStorage) {
    //   if (this.#storage[name]) throw new Error(`Extension ${name} already registered.`);
    //   this.#storage[name] = extensionClass;
    // }
    extensionClass.setup(require('./index.js'));
  }

  /**
   * @template {typeof OcflExtension} T
   * @param {OcflExtensionConfig} [config]
   * @this {T}
   * @return {InstanceType<T>}
   */
   static create2(config){
    if (!config?.extensionName || this.NAME === config.extensionName) return /**@type {InstanceType<T>}*/(new this(config));
    return OcflExtension.class(config.extensionName).create2(config);
  }
  /**
   * Create an instance of the extension
   * @type {<T extends typeof OcflExtension>(this: T, config?: OcflExtensionConfig) => InstanceType<T>}
   */
  static create = function (config) {
    // @ts-ignore
    if (!config?.extensionName || this.NAME === config.extensionName) return new this(config);
    // @ts-ignore
    return OcflExtension.class(config.extensionName).create(config);
  }

  static get forObject() { return false; }
  static get forStorage() { return false; }
  static setup(ocfl) { };
  static get NAME() { return '0000-example-extension' }
  static get DESCRIPTION() { return 'Example extension' }

  /**
   * 
   * @param {OcflExtensionConfig} [config]
   * @param {C} [defaultConfig]
   */
  constructor(config, defaultConfig) {
    /** @type {C} */
    this.parameters = defaultConfig ? Object.create(/**@type{object}*/(defaultConfig)) : {};
    if (typeof config === 'object') {
      for (let k in config) {
        if (k in defaultConfig) this.parameters[k] = config[k];
      }
    }
  }

  /** Return all the parameters in which the value has been set to non-default value */
  get config() {
    let paramNames = Object.keys(this.parameters);
    if (paramNames.length > 0) {
      return paramNames.reduce( (params, name) => (params[name] = this.parameters[name], params), {extensionName: this.name});
    } 
  }

  get p() { return this.parameters; }
  
  /** Extension registered name */
  get name() { return /** @type {typeof OcflExtension}*/(this.constructor).NAME }
  get description() { return /** @type {typeof OcflExtension}*/(this.constructor).DESCRIPTION }
  get minOcflVersion() { return "1.0" }
  get version() { return "1.0" }
  
  /**
   * Get the specified parameter value
   * @param {string} param - The extension parameter name
   * @return {*}
   */
  get(param) { return this.parameters[param]; }
  
  /**
   * Set the specified parameter value
   * @param {string} param  - The extension parameter name
   * @param {*} value - The extension parameter value
   */
  set(param, value) { if (param in this.parameters) this.parameters[param] = value; }
}


/**
 * @template {{}} C
 * @extends {OcflExtension<C>}
 */
class OcflStorageLayout extends OcflExtension {

  static get layout() {
    return storageLayout;
  }

  /**
   * 
   * @param {string} name 
   * @return {typeof OcflStorageLayout} 
   */
  static class(name) {
    let c = super.class(name);
    if (c && c.prototype instanceof OcflStorageLayout) return /** @type {typeof OcflStorageLayout} */(c);
  }

  static get classes() {
    return Object.values(storageLayout);
  }

  /**
   * Register a storage layout extension
   * @param {typeof OcflStorageLayout} extensionClass 
   */
  static register(extensionClass = this) {
    super.register(extensionClass);
    storageLayout[extensionClass.name] = extensionClass;
  }

  static get forStorage() { return true; }

  /**
   * 
   * @param {OcflExtensionConfig} [config] 
   * @param {C} [defaultConfig]
   */
  constructor(config, defaultConfig) { super(config, defaultConfig); }

  /**
   * Map an object identifier to a path
   * @param {string} id - The identifier of the OCFL Object
   * @return {string} 
   */
  map(id) { throw new NotImplementedError(); }
}

module.exports = {
  OcflExtension,
  OcflStorageLayout
};