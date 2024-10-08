const path = require('path');
const { pipeline } = require('stream/promises');
const { parallelize, dataSourceAsIterable } = require('./utils');

const emptyOptions = {};

/**
 * Abstract class to provide common APIs to access and modify the actual data store backend 
 * such as local file system and cloud storage
 */
class OcflStore {
  static instances;

  /**
   * 
   * @param {Object} [options] 
   */
  static getInstance(options = emptyOptions) {
    if (!this.instances) return new this(options);
    let store = this.instances.get(options);
    if (!store) {
      store = new this(options);
      this.instances.set(options, store);
    }
    return store;
  }

  constructor(options) { }

  /**
   * Get file information.
   * @param {string} filePath 
   * @return {Promise<import('fs').Stats>}
   */
  async stat(filePath) { throw new Error('Not Implemented'); }

  /**
   * Check if file exists
   * @param {string} filePath 
   */
  async exists(filePath) {
    try {
      await this.stat(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
  * Create a readable stream to get the content of a file
  * @param {string} filePath - Absolute path
  * @param {*} options 
  * @return {Promise<import('fs').ReadStream>}
  * @deprecated
  */
  async createReadStream(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * Create a stream that writes data to {@link relPath}. 
   * @param {string} relPath 
   * @param {*} options 
   * @return {Promise<import('fs').WriteStream>}
   * @deprecated
   */
  async createWriteStream(relPath, options) { throw new Error('Not Implemented'); }

  /**
  * Create a ReadableStream to get the content of a file
  * @param {string} filePath - Absolute path
  * @param {*} options 
  * @return {Promise<ReadableStream>}
  */
  async createReadable(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * Create a WritableStream that writes data to {@link relPath}. 
   * @param {string} relPath 
   * @param {*} options 
   * @return {Promise<WritableStream>}
   */
  async createWritable(relPath, options) { throw new Error('Not Implemented'); }

  /**
   * Provide a common interface to read a file inside an object. 
   * A concrete subclass MAY implement this method to provide read access to its underlying storage backend.
   * The default implementation uses the {@linkcode OcflStore#createReadStream} method.
   * @param {string} filePath 
   * @param {*} [options] 
   */
  async readFile(filePath, options) {
    let rs = await this.createReadStream(filePath, options);
    let chunks = [];
    for await (const chunk of rs) {
      chunks.push(chunk);
    }
    if (typeof options === 'string' || options.encoding) {
      return Buffer.concat(chunks);
    } else {
      return chunks.join('');
    }
  }

  /** @typedef {string|Buffer|NodeJS.ArrayBufferView|AsyncIterable|Iterable|import('stream').Readable} WriteFileData */
  /**
   * Provide a common interface to write a file inside an object. 
   * A concrete subclass MAY implement this method to provide write access to its underlying storage backend.
   * The default implementation uses the {@link OcflStore.createWriteStream} method.
   * @param {string} filePath - Absolute path to the file.
   * @param {WriteFileData} data - The data to be written to the file. 
   * @param {Object|string} options 
   */
  async writeFile(filePath, data, options) {
    var source = dataSourceAsIterable(data);
    await this.mkdir(path.dirname(filePath));
    const target = await this.createWriteStream(filePath, options);
    await pipeline(source, target);
  }

  /**
   * Copy file from `source` to `target`.
   * By default, target is overwritten if it already exists.
   * @param {string} source - source filename to copy
   * @param {string} target - destination filename of the copy operation
   */
  async copyFile(source, target) {
    await this.writeFile(target, await this.createReadStream(source));
  }

  /**
   * Open a directory
   * @param {string} filePath 
   * @param {*} options
   * @return {Promise<import('fs').Dir> }
   */
  async opendir(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * Read a directory
   * @param {string} filePath 
   * @param {*} options
   * @return {Promise<string[]> }
   */
  async readdir(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * List all files contained in a directory including the metadata such as size and last modified date.
   * The returned file.path is a relative path to the dirPath
   * @param {string} dirPath 
   * @param {object} [options]
   * @param {BufferEncoding} [options.encoding]
   * @param {number} [options.bufferSize]
   * @param {boolean} [options.recursive]
   * @return {Promise<AsyncIterableIterator<{name: string, path: string, size: number, lastModified: Date}>> }
   */
  async list(dirPath, { encoding='utf8', bufferSize=32, recursive=false} = {}) { throw new Error('Not Implemented'); }

  /**
  * Recursively create a directory if the storage backend supports it, otherwise do nothing
  * @param {string} filePath - The directory path
  * @param {*} [options] - Options to be passed to the underlying method
  * @return {Promise<string>} - The first directory path created
  */
  async mkdir(filePath, options) { throw new Error('Not Implemented'); }

  /**
   * Rename or move a file or directory
   * @param {string} source 
   * @param {string} target 
   */
  async move(source, target) { throw new Error('Not Implemented'); }

  /**
   * Remove a file or directory recursively
   * @param {*} filePath 
   */
  async remove(filePath) { throw new Error('Not Implemented'); }

}

module.exports = {
  OcflStore
};