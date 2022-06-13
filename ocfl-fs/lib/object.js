//@ts-check
console.log('11111111111111');
const { OcflObject, 
  OcflObjectImpl, 
  OcflObjectTransactionImpl,
  createTransactionProxy,
  createObjectProxy,
  OcflConstants } = require('ocfl');
const path = require('path');
const { mkdir, copyFile, rename, unlink } = require('fs/promises');
const { PassThrough } = require('stream');
const { assert } = require('console');

const { INVENTORY_NAME } = OcflConstants;

/**
 * @typedef {Object} OcflObjectConfigFs
 * @property {*} [fs] - Custom fs module to use for any file operation 
 */

/**
 * @typedef {import('ocfl/lib/object').OcflObjectConfig} OcflObjectConfig
 */

/**
 * OCFL Object backed by local filesystem
 * @implements OcflObject
 */
class OcflObjectFs extends OcflObjectImpl {
  /**
   * Create a new OCFL Object in the locally mounted file system
   * @param {OcflObjectConfig & OcflObjectConfigFs} config
   */
  constructor(config) {
    super(config);
    /** @type {import('fs')} */
    this.fs = config.fs ?? require('fs');
  }

  async _createDir(filePath) {
    return this.fs.promises.mkdir(this.toAbsPath(filePath), { recursive: true });
  }

  async _createReadStream(filePath, options) {
    filePath = this.toAbsPath(filePath);
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return this.fs.createReadStream(filePath, options);
  }

  async _createWriteStream(filePath, options) { 
    filePath = this.toAbsPath(filePath);
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return this.fs.createWriteStream(filePath, options);
  }

  async _readFile(filePath, options) {
    return this.fs.promises.readFile(this.toAbsPath(filePath), options);
    //if (err.code !== 'ENOENT') throw validation.createError(34, invPath);
  }

  async _readDir(filePath, options) {
    return this.fs.promises.readdir(this.toAbsPath(filePath), options); 
  }

  async _writeFile(filePath, data, options) {
    filePath = this.toAbsPath(filePath);
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await this.fs.promises.writeFile(filePath, data, options);
  }

  async _copyFile(source, target) {
    source = this.toAbsPath(source);
    target = this.toAbsPath(target);
    await this.fs.promises.mkdir(path.dirname(target), { recursive: true });
    await this.fs.promises.copyFile(source, target);
  }

  async _move(source, target) {
    source = this.toAbsPath(source);
    target = this.toAbsPath(target);
    try {
      await this.fs.promises.rename(source, target);
    } catch (error) {
      if (error.code === 'EXDEV') {
        await this.fs.promises.cp(source, path.dirname(target), { recursive: true, preserveTimestamps: true });
        await this.fs.promises.rm(this.toAbsPath(target), { recursive: true, force: true })
      } else {
        throw error;
      }
    }
  }

  async _remove(filePath) {
    this.fs.promises.rm(this.toAbsPath(filePath), { recursive: true, force: true })
  }

  async _stat(filePath) { 
    return this.fs.promises.stat(this.toAbsPath(filePath));    
  }

};

/**
 * Create an OCFL Object
 * @param {OcflObjectConfig} config
 * @return {OcflObject}
 */
function createObject(config) {
  return createObjectProxy(new OcflObjectFs(config)); 
}

module.exports = { OcflObjectFs, createObject };