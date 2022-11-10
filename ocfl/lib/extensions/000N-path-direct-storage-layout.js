const { OcflStorageLayout } = require("../extension");
const { OcflDigest } = require("../digest");
const path = require("path");

const DefaultConfig = {
  extensionName: '000N-path-direct-storage-layout',
  omitSchema: false,
  /** @type {any} */
  replace: [],
  suffix: '/__object__'
};

/** @typedef {Partial<typeof DefaultConfig>} PathDirectStorageLayoutConfig */
/**
 * @extends {OcflStorageLayout<typeof DefaultConfig>}
 */
class PathDirectStorageLayout extends OcflStorageLayout {
  static get NAME() { return DefaultConfig.extensionName; }
  static get DESCRIPTION() {
    return "OCFL object identifiers are used directly as the path.";
  }

  /**
   * 
   * @param {PathDirectStorageLayoutConfig} [config] 
   */
  constructor(config) {
    super(config, DefaultConfig);
  }

  /**
   * @param {string} id
   * @return {string} 
   */
  map(id) {
    var suffix = this.parameters.suffix;
    if (suffix && id.endsWith(suffix)) throw new Error(`Identifier cannot end with '${suffix}'`);
    var p = id ?? '';
    for (const r of this.parameters.replace) {
      p = p.replace(r[0], r[1]);
    }
    try {
      let u = new URL(p);
      let parts = [];
      if (!this.parameters.omitSchema && u.protocol !== 'file:') {
        parts.push(u.protocol.replace(':', ''));
      }
      if (u.hostname) {
        parts.push(u.hostname.replace(',', '_').replace(';', '/'));
      }
      p = path.join(parts.join('_'), u.pathname + u.search + u.hash);
    } catch (error) {
    }
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    return path.join(p, this.parameters.suffix);
    //if (/^\w+:/.test(id)) {
  }

}

module.exports = { PathDirectStorageLayout };
