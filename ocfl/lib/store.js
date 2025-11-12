const path = require('path');
const { parallelize, joinTypedArray } = require('./utils');

const emptyOptions = {};

/**
 * Abstract class to provide common APIs to access and modify the actual data store backend 
 * such as local file system and cloud storage
 */
class OcflStore {
  /** @type {Map<Object, OcflStore>} */
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
   * The default implementation uses the {@linkcode OcflStore#createReadable} method.
   * @param {string} filePath 
   * @param {*} [options] 
   */
  async readFile(filePath, options) {
    const rs = await this.createReadable(filePath, options);
    let buffer = (typeof options === 'string' || options.encoding) ? '' : new Uint8Array(new ArrayBuffer(0, { maxByteLength: 16 * 1024 }));
    for await (const chunk of rs) {
      if (typeof chunk === 'string') {
        if (typeof buffer !== 'string') buffer = new TextDecoder().decode(buffer);
        buffer += chunk;
      } else {
        if (typeof buffer === 'string') buffer = new TextEncoder().encode(buffer);
        // @ts-ignore
        buffer = joinTypedArray(buffer, chunk);
      }
    }
    return buffer;
  }

  /** @typedef {string|Buffer|Uint8Array|DataView|AsyncIterable|Iterable|ReadableStream} WriteFileData */
  /**
   * Provide a common interface to write a file inside an object. 
   * A concrete subclass MAY implement this method to provide write access to its underlying storage backend.
   * The default implementation uses the {@link OcflStore.createWriteStream} method.
   * @param {string} filePath - Absolute path to the file.
   * @param {WriteFileData} data - The data to be written to the file. 
   * @param {Object|string} options 
   */
  async writeFile(filePath, data, options) {
    await this.mkdir(path.dirname(filePath));
    const target = await this.createWritable(filePath, options);
    if (data instanceof ReadableStream) {
      await data.pipeTo(target);
    } else {
      const w = target.getWriter();
      await w.write(data);
      await w.close();
    }
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