//@ts-check
/** Models a set of ocfl object modifying operations as a transaction that is as close as atomic as possible */
const { createReadStream } = require('fs');
const { stat, readdir } = require('fs/promises');
const path = require('path');
const { parallelize, dataSourceAsIterable } = require('./utils');
const { OcflDigest } = require('./digest');
const { INVENTORY_NAME } = require('./constants').OcflConstants;

//const { pipeline } = require('stream/promises');
//const { OcflObjectImpl, OcflObjectInventory } = require('./object');

/**
 * @typedef {import('./object').OcflObjectImpl} OcflObjectImpl
 * @typedef {import('./inventory').OcflObjectInventoryMut} OcflObjectInventoryMut
 * @typedef {import('stream').Writable} Writable
 * @typedef {import('stream').StreamOptions} StreamOptions
 */

/**
 * A Transaction represent an atomic update on an OCFL Object. 
 * When a transaction is commited, all changes are saved as a new version.
 * This is a wrapper class to hide all the storage specific implementation.
 */
class OcflObjectTransaction {

  /**
   * Discard all the changes made in this transaction,
   * @abstract
   */
  async rollback() { throw new Error('Not Implemented'); }

  /**
   * Commit all the changes made in this transaction to the actual OCFL Object.
   * @abstract
   * @param {Object} [options] - Commit options. message and user will be included in the version entry of the inventory.json
   * @param {string} [options.message] - Freeform text used to record the rationale for creating the current version
   * @param {Object} [options.user] - Identify the user or agent that created the current Version
   * @param {string} options.user.name - Any readable name of the user, e.g., a proper name, user ID, agent ID.
   * @param {string} [options.user.address] - A URI: either a mailto URI [RFC6068] with the e-mail address of the user or a URL to a personal identifier, e.g., an ORCID iD.
   */
  async commit(options) { throw new Error('Not Implemented'); }

  /**
   * Completely remove a file path and corresponding content from all versions of an OCFL Object.
   * This is a special case that is not supported as part of regular OCFL versioning operations.
   * @param {*} logicalPath 
   */
  async purge(logicalPath) {
    return await this.remove(logicalPath, { purge: true });
  }


  /**
   * Write data to a file at `logicalPath`
   * @abstract
   * @param {string} logicalPath - A path relative to the object content directory
   * @param {*} data - The same data as https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback
   * @param {Object|string} options - The same options as https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback
   */
  async write(logicalPath, data, options) { throw new Error('Not Implemented'); }

  /**
   * Import content by recursively copying a file or directory from local file system to the 
   * OCFL Object content. For example, `copy('/home/john/data/b','data/b')` will
   * copy `/home/john/data/b` from the local filesystem to the content `data/b` in the OFCL Object.
   * Set target to empty string ('') to copy a directory content to the object's content root.
   * If target is not specified, the base name of the source will be used.
   * @abstract
   * @param {string} source - A path to a file or directory in the local filesystem to be copied
   * @param {string} [target] - A logical path in the OCFL Object content.
   */
  async import(source, target) { throw new Error('Not Implemented'); }

  /**
   * Duplicate the logical path `source` as a different logical path `target`, both will then point
   * to the same content path and bitstreams.
   * @abstract
   * @param {string} source - The logical path to be copied
   * @param {string} target - The target logical path
   */
  async copy(source, target) { throw new Error('Not Implemented'); }

  /**
  * Changes the logical path of existing content. This is similar to move operation in file systems
  * This operation will NOT rename the actual file name referenced by the manifest.
  * @abstract
  * @param {*} source 
  * @param {*} target 
  */
  async rename(source, target) { throw new Error('Not Implemented'); }

  /**
   * Changes the file path of existing content. This is similar to move operation in file systems
   * @param {*} source 
   * @param {*} target 
   */
  async move(source, target) { return this.rename(source, target); }

  /**
  * Remove a file or directory
  * @abstract
  * @param {string} logicalPath - A path relative to the object content directory
  * @param {Object} options
  */
  async remove(logicalPath, options) { throw new Error('Not Implemented'); }

  /**
   * Remove a file or directory
   * @param {string} logicalPath - A path relative to the object content directory
   * @param {Object} options
   */
  async delete(logicalPath, options) { return this.remove(logicalPath, options); }

  /**
   * Makes content from a version earlier than the previous version available in the current version of an OCFL Object.
   * @abstract
   * @param {string} logicalPath 
   * @param {string} versionName 
   * @return {Promise<number>}
   */
  async reinstate(logicalPath, versionName) { throw new Error('Not Implemented'); }

  /**
   * Create a writable stream
   * @abstract
   * @param {string} logicalPath 
   * @param {BufferEncoding|StreamOptions} [options] 
   * @return {Promise<import('stream').Writable>} 
   */
  async createWriteStream(logicalPath, options) { throw new Error('Not Implemented'); }

}


/**
 * Base class for any transaction implementation on different storage backend
 */
class OcflObjectTransactionImpl extends OcflObjectTransaction {
  _contentRoot;
  _object;
  _inventory;
  _committed = false;
  _unfinished = 0;


  /**
   * 
   * @param {OcflObjectImpl} ocflObject 
   * @param {OcflObjectInventoryMut} inventory 
   * @param {string} workspaceVersionPath 
   * @param {string} createdDir 
   */
  constructor(ocflObject, inventory, workspaceVersionPath, createdDir) {
    super();
    this._workspaceVersionPath = workspaceVersionPath;
    this._contentRoot = path.join(workspaceVersionPath, inventory.contentDirectory);
    this._object = ocflObject;
    this._inventory = inventory;
    this._createdDir = createdDir;
    this._queue = [];
  }

  _getRealPath(logicalPath) {
    let p = path.normalize(logicalPath);
    if (p.startsWith('/') || p.startsWith('..')) throw new Error('logicalPath must be a relative path without `..`');
    return path.join(this._contentRoot, p);
  }

  async rollback() {
    if (!this._committed) {
      await Promise.all(this._queue);
      await this._object._remove(this._createdDir);
      this._committed = true;
    }
  }

  async commit(options) {
    // console.log('commit');
    // console.log(this._inventory.toString());
    if (!this._committed) {
      let count = this._unfinished;
      if (count > 0) {
        await this.rollback();
        throw new Error(`Unfinished operations detected (${count}). Make sure that updater callback is async function and there are no floating promises inside.`);
      }
      // if there is no changes, abort commit
      if (!this._inventory.isChanged) {
        return await this.rollback();
      }
      await this._commit(options);
      this._object._setInventory(this._inventory);
      this._committed = true;
    }

  }
  //todo: commit message and user
  async _commit(options = {}) {
    // set commit info
    this._inventory.created = (new Date()).toISOString();
    if (options.message) this._inventory.message = options.message;
    if (options.user) this._inventory.user = options.user;

    let workspaceVersionPath = this._workspaceVersionPath;
    let objectVersionPath = path.join(this._object.root, this._inventory.head);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json */
    let invPath = path.join(workspaceVersionPath, INVENTORY_NAME);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json.sha512 */
    let invDigestPath = invPath + '.' + this._inventory.digestAlgorithm;

    // calculate digest
    let digest = this._inventory.digest() + ' ' + INVENTORY_NAME;
    // write inventory.json to workspace
    await this._object._writeFile(invPath, this._inventory.toString());
    await this._object._writeFile(invDigestPath, digest);
    if (workspaceVersionPath !== objectVersionPath) {
      try {
        await this._object._ensureNamaste();
        await this._object._move(workspaceVersionPath, objectVersionPath);
        await this._object._remove(this._createdDir);
      } catch (error) {
        await this.rollback();
        throw error;
      }
    }
    // replace root inventory
    /* eg: /data/aa/bb/cc/object-1/inventory.json */
    let rootInvPath = path.join(this._object.root, INVENTORY_NAME);
    /* eg: /data/aa/bb/cc/object-1/v1/inventory.json */
    invPath = path.join(objectVersionPath, INVENTORY_NAME);
    invDigestPath = invPath + '.' + this._inventory.digestAlgorithm;
    let rootInvDigestPath = rootInvPath + '.' + this._inventory.digestAlgorithm;
    await this._object._copyFile(invPath, rootInvPath + '.tmp');
    await Promise.all([
      this._object._move(rootInvPath + '.tmp', rootInvPath),
      this._object._copyFile(invDigestPath, rootInvDigestPath)]);

  }

  /**
   * 
   * @param {string} logicalPath 
   * @param {Object} options
   * @return {Promise<import('stream').Writable>} 
   */
  async createWriteStream(logicalPath, options) {
    let realPath = this._getRealPath(logicalPath);
    let ws = await this._object._createWriteStream(realPath, options);
    let hs = OcflDigest.createStream(this._inventory.digestAlgorithm);
    const wwrite = ws.write;
    function nwrite(chunk, encoding, cb) {
      hs.update(chunk, encoding);
      return wwrite.apply(ws, arguments);
    };
    ws.write = nwrite;
    ws.on('close', async () => {
      let digest = hs.digest('hex');
      if (this._inventory.getContentPath(digest)) await this._object._remove(realPath);
      this._inventory.add(logicalPath, digest);
    });
    return ws;
  }

  async write(logicalPath, data, options) {
    let realPath = this._getRealPath(logicalPath);
    let dataSrc = dataSourceAsIterable(data);
    let digest;
    if (Array.isArray(dataSrc)) {
      // if data is not stream, check digest first
      digest = await OcflDigest.digestAsync(this._inventory.digestAlgorithm, dataSrc);
      if (!this._inventory.getContentPath(digest)) {
        // no digest yet, write the file to storage backend
        await this._object._writeFile(realPath, data, options);
      }
    } else {
      // save the stream first
      let hs = OcflDigest.createStreamThrough(this._inventory.digestAlgorithm);
      data.pipe(hs);
      await this._object._writeFile(realPath, hs, options);
      digest = hs.digest();
      // already exists, delete temp file
      if (this._inventory.getContentPath(digest)) await this._object._remove(realPath);
    }
    this._inventory.add(logicalPath, digest);
    // console.log(this._inventory.toString());
  }

  async importFile(source, target) {
    if (!target) throw new TypeError('Target logical path must not be empty if source is a file.');
    let realPath = this._getRealPath(target);
    let digest = await OcflDigest.digestFromFile(this._inventory.digestAlgorithm, source);

    if (!this._inventory.getContentPath(digest)) {
      await this._object._copyFile(source, realPath);
    }
    this._inventory.add(target, digest);
  }

  async import(source, target) {
    target = target ?? path.basename(source);
    let srcStat = await stat(source);
    if (srcStat.isFile()) {
      await this.importFile(source, target);
    } else if (srcStat.isDirectory()) {
      const files = await readdir(source);
      await parallelize(files, async (filename) => {
        await this.import(path.join(source, filename), path.join(target, filename));
      });
    }
  }

  async copy(source, target) {
    return this._inventory.copy(source, target);
  }

  async rename(source, target) {
    // if file already exists in the workspace, rename the actual file
    try {
      let realSource = this._getRealPath(source);
      let realTarget = this._getRealPath(target);
      await this._object._move(realSource, realTarget);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this._inventory.rename(source, target);
  }

  async reinstate(logicalPath, versionName) {
    //let digest = this._inventory.getDigestFromLogical(logicalPath);
    let count = this._inventory.reinstate(logicalPath, versionName);
    // if (count) {
    //   // ensure no existing file with the same logical path in the workspace
    //   try {
    //     await this._object._remove(this._getRealPath(logicalPath));
    //   } catch (error) {
    //     if (error.code !== 'ENOENT') throw error;
    //   }
    // }
    return count;
  }

  async remove(logicalPath, options) {
    if (this._inventory.delete(logicalPath)) {
      try {
        await this._object._remove(this._getRealPath(logicalPath));
      } catch (error) {

      }
    }
  }

}


const transactionInterface = new OcflObjectTransaction();
const methodWrapper = {
  createWriteStream: async function (logicalPath, options) {
    if (this._committed) throw new Error('Transaction already commited');
    this._unfinished++;
    let result = await this.createWriteStream(logicalPath, options);
    result.on('close', () => --this._unfinished);
    return result;
  }
};
['write', 'import', 'copy', 'rename', 'remove', 'reinstate'].forEach(name => {
  methodWrapper[name] = async function () {
    if (this._committed) throw new Error('Transaction already commited');
    this._unfinished++;
    let p = this[name](...arguments);
    this._queue.push(p);
    try {
      let result = await p;
      this._unfinished--;
      return result;
    } catch (error) {
      this._unfinished--;
      throw error;
    }
  };
});
const proxyHandler = {
  /**
   * @param {OcflObjectTransactionImpl} target 
   * @param {string} prop 
   */
  get(target, prop) {
    if (prop in transactionInterface) {
      let p = target[prop];
      if (typeof p === 'function') {
        return methodWrapper[prop]?.bind(target) ?? p.bind(target);
      } else {
        return p;
      }
    }
  }
}

/**
 * Return any OcflObjectTransactionImpl implementation as OcflObjectTransaction.
 * @param {OcflObjectTransactionImpl} impl
 * @return {OcflObjectTransaction}
 */
function createTransactionProxy(impl) {
  return new Proxy(impl, proxyHandler);
}

module.exports = {
  createTransactionProxy,
  OcflObjectTransaction,
  OcflObjectTransactionImpl
};
