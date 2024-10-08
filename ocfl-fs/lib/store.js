//@ts-check
const path = require('path');
const fs = require('node:fs');
const { Readable, Writable } = require('node:stream');

const { OcflStore, OcflConstants } = require('@ocfl/ocfl');
const { opendir } = require('./utils.js');
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

  async createReadable(filePath, options) {
    return Readable.toWeb(this.fs.createReadStream(filePath, options));
  }

  async createWritable(filePath, options) {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return Writable.toWeb(this.fs.createWriteStream(filePath, options));
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

  /**
   * @param {string} dirPath 
   * @param {OpenDirOptions} [options]
   * @return {Promise<AsyncIterableIterator<{name: string, path: string, size: number, lastModified: Date}>> }
   */
  async list(dirPath, { encoding = 'utf8', bufferSize = 32, recursive = false } = {}) {
    const {opendir, stat} = this.fs.promises;
    const maxBuffer = bufferSize || 1;
    async function* generator() {
      /** @type Promise<{ name: string, path: string, size: number, lastModified: Date}>[] */
      let buffer = [];
      let dirp;
      const dirQueue = [opendir(dirPath, { encoding, bufferSize })];
      while (dirp = dirQueue.shift()) {
        const dir = await dirp;
        for await (const de of dir) {
          const cdp = path.join(dir.path, de.name);
          if (recursive && de.isDirectory()) {
            dirQueue.push(opendir(cdp, { encoding, bufferSize }));
          } else {
            let f = stat(cdp).then(stats => ({
              name: de.name,
              path: path.relative(dirPath, cdp),
              size: stats.size,
              lastModified: stats.mtime
            }));
            if (buffer.length < maxBuffer) {
              buffer.push(f);
            } else {
              yield buffer.shift();
              buffer.push(f);
            }
          }
        }
      }
      let file;
      while (file = buffer.shift()) {
        yield file;
      }
    }
    return generator();
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