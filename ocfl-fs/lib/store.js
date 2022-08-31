//@ts-check
const path = require('path');
const fs = require('fs');
const { mkdir, copyFile, rename, unlink } = fs.promises;

const { OcflStore, OcflConstants } = require('@ocfl/ocfl');
const { INVENTORY_NAME } = OcflConstants;

/**
 * @typedef {Object} OcflFsStoreConfig
 * @property {typeof fs} [fs] - Custom fs module to use for any file operation 
 */

/**
 * OCFL Object backed by local filesystem
 */
class OcflFsStore extends OcflStore {
  /** @type {Map<Object, OcflFsStore>} */
  static instances = new Map();

  /**
   * 
   * @param {Object} options 
   * @param {typeof fs} [options.fs]
   */
  // static getInstance({fs = require('fs')} = {}) {
  //   let store = OcflFsStore.instances.get(fs);
  //   if (!store) {
  //     store = new OcflFsStore({fs});
  //     OcflFsStore.instances.set(fs, store);
  //   }
  //   return store;
  // }

  /**
   * Create a new backend store that uses the given fs api.
   * A typical use case would be a locally mounted file system.
   * @param {OcflFsStoreConfig} [config]
   */
  constructor(config) {
    super();
    this.fs = config?.fs ?? fs;
  }

  async stat(filePath) { 
    return this.fs.promises.stat(filePath);    
  }

  async createReadStream(filePath, options) {
    //await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return this.fs.createReadStream(filePath, options);
  }

  async createWriteStream(filePath, options) { 
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return this.fs.createWriteStream(filePath, options);
  }

  async readFile(filePath, options) {
    return this.fs.promises.readFile(filePath, options);
    //if (err.code !== 'ENOENT') throw validation.createError(34, invPath);
  }

  async writeFile(filePath, data, options) {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await this.fs.promises.writeFile(filePath, data, options);
  }

  async copyFile(source, target) {
    await this.fs.promises.mkdir(path.dirname(target), { recursive: true });
    await this.fs.promises.copyFile(source, target);
  }

  async opendir(filePath, options) {
    return this.fs.promises.opendir(filePath, options); 
  }

  async readdir(filePath, options) {
    return this.fs.promises.readdir(filePath, options); 
  }

  async mkdir(filePath, options = { recursive: true }) {
    return this.fs.promises.mkdir(filePath, options);
  }

  async move(source, target) {
    try {
      return this.fs.promises.rename(source, target);
    } catch (error) {
      if (error.code === 'EXDEV') {
        await this.fs.promises.cp(source, path.dirname(target), { recursive: true, preserveTimestamps: true });
        return this.fs.promises.rm(target, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  }

  async remove(filePath) {
    return this.fs.promises.rm(filePath, { recursive: true, force: true });
  }


};

module.exports = { OcflFsStore };