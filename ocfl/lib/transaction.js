//@ts-check
/** Models a set of ocfl object modifying operations as a transaction that is as close as atomic as possible */
//todo: replace path module with a more generic path module that works in both node and browser
const path = require('path');
const { parallelize } = require('./utils');
const { OcflDigest } = require('./digest');
const { INVENTORY_NAME } = require('./constants').OcflConstants;

//const { pipeline } = require('stream/promises');
//const { OcflObjectImpl, OcflObjectInventory } = require('./object');

/**
 * @typedef {import('./object').OcflObjectImpl} OcflObjectImpl
 * @typedef {import('./store').OcflStore} OcflStore
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
   * @param {boolean} [options.force=false] - If true, force to commit. Use it after a purge.
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
   * @param {string|Uint8Array|DataView|ArrayBuffer|ReadableStream} data - Data to be written to the file
   * @param {Object|string} [options] - The same options as https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback
   */
  async write(logicalPath, data, options) { throw new Error('Not Implemented'); }

  /**
   * Import content by recursively copying a file or directory from local file system to the 
   * OCFL Object content. For example, `object.import('/home/john/data/b','data/b')` will
   * copy `/home/john/data/b` from the local filesystem to the content `data/b` in the OFCL Object.
   * Set target to empty string ('') to copy a directory content to the object's content root.
   * If target is not specified, the base name of the source will be used.
   * For examples:
   * To copy '/src/data' directory as 'data' use import('/src/data', 'data'). 
   * To copy all files inside '/src/data' directory to the logical root, use import('/src/data', ''). 
   * @abstract
   * @param {string} source - A path to a file or directory in the local filesystem to be copied
   * @param {string} [target] - A logical path in the OCFL Object content.
   */
  async import(source, target) { throw new Error('Not Implemented'); }

  /**
   * Duplicate the logical path `source` as a different logical path `target`, both paths will then point
   * to the same content path and bitstreams.
   * @abstract
   * @param {string} source - The logical path to be copied
   * @param {string} target - The target logical path
   */
  async copy(source, target) { throw new Error('Not Implemented'); }

  /**
  * Changes the logical path of existing content. This is similar to move operation in file systems
  * Unless renaming files that are not yet commited, this operation will NOT rename the actual file name referenced by the manifest.
  * @abstract
  * @param {*} source 
  * @param {*} target 
  */
  async rename(source, target) { throw new Error('Not Implemented'); }

  /**
   * Alias of {@link rename()}
   * @param {*} source 
   * @param {*} target 
   */
  async move(source, target) { return this.rename(source, target); }

  /**
  * Remove a file or directory
  * @abstract
  * @param {string} logicalPath - A path relative to the object content directory
  * @param {Object} [options]
  * @param {boolean} [options.purge=false] - If true, completely remove the content from all versions
  */
  async remove(logicalPath, options) { throw new Error('Not Implemented'); }

  /**
   * Remove a file or directory. Alias of {@link remove()}
   * @param {string} logicalPath - A path relative to the object content directory
   * @param {Object} [options]
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
   * Create a NodeJS writable stream
   * @abstract
   * @param {string} logicalPath 
   * @param {BufferEncoding|StreamOptions} [options] 
   * @return {Promise<import('stream').Writable>} 
   * @deprecated Use {@link createWritable()} instead
   */
  async createWriteStream(logicalPath, options) { throw new Error('Not Implemented'); }

  /**
   * Create a writable stream
   * @abstract
   * @param {string} logicalPath 
   * @param {*} [options] 
   * @return {Promise<WritableStream>} 
   */
  async createWritable(logicalPath, options) { throw new Error('Not Implemented'); }
}


/**
 * Base class for any transaction implementation on different storage backend
 */
class OcflObjectTransactionImpl extends OcflObjectTransaction {
  _contentRoot;
  _object;
  _inventory;
  _committed = false;

  /**
   * 
   * @param {OcflObjectImpl} ocflObject 
   * @param {OcflStore} ocflStore 
   * @param {OcflObjectInventoryMut} inventory 
   * @param {string} workspaceVersionPath 
   * @param {string} createdDir 
   */
  constructor(ocflObject, ocflStore, inventory, workspaceVersionPath, createdDir) {
    super();
    this._workspaceVersionPath = workspaceVersionPath;
    this._contentRoot = path.join(workspaceVersionPath, inventory.contentDirectory);
    this._object = ocflObject;
    this._store = ocflStore;
    this._inventory = inventory;
    this._createdDir = createdDir;
    /** @type {(Promise<any> & { done?: boolean})[]} */
    this._queue = [];
  }

  /**
   * Create a new transaction instance.
   * @param {OcflObjectImpl} ocflObject 
   * @param {OcflStore} ocflStore 
   * @param {OcflObjectInventoryMut} inventory 
   * @param {string} workspacePath 
   */
  static async create(ocflObject, ocflStore, inventory, workspacePath) {
    // @todo: validate existing object
    // check existing 
    let workspaceVersionPath = path.join(workspacePath, inventory.head);
    if (await ocflStore.exists(workspaceVersionPath)) {
      // workspace dir exists, abort update
      throw new Error('Uncommitted changes detected. Object is being updated by other process or there has been a failed update attempt');
    }
    await ocflStore.mkdir(workspacePath);
    return new OcflObjectTransactionImpl(ocflObject, ocflStore, inventory, workspaceVersionPath, workspacePath);
  }

  _getRealPath(logicalPath) {
    let p = path.normalize(logicalPath);
    if (p.startsWith('/') || p.startsWith('..')) throw new Error('logicalPath must be a relative path without `..`');
    return path.join(this._contentRoot, p);
  }

  async rollback() {
    if (!this._committed) {
      await Promise.all(this._queue);
      if (this._createdDir) await this._store.remove(this._createdDir);
      this._committed = true;
    }
  }

  async commit(options) {
    // console.log('commit');
    // console.log(this._inventory.toString());
    if (!this._committed) {
      let count = this._queue.filter(p => !p.done).length;
      if (count > 0) {
        await this.rollback();
        throw new Error(`Unfinished operations detected (${count}). Make sure that updater callback is async function and there are no floating promises inside.`);
      }
      // if there is no changes, abort commit
      if (!options?.force && !this._inventory.isChanged) {
        return await this.rollback();
      }
      await this._commit(options);
      this._object._setInventory(this._inventory);
      this._committed = true;
    }

  }

  async _commit(options = {}) {
    const inventory = this._inventory;
    const digestAlgorithm = inventory.digestAlgorithm;
    // set commit info
    inventory.created = (new Date()).toISOString();
    if (options.message) inventory.message = options.message;
    if (options.user) inventory.user = options.user;

    let workspaceVersionPath = this._workspaceVersionPath;
    let objectVersionPath = path.join(this._object.root, inventory.head);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json */
    let invPath = path.join(workspaceVersionPath, INVENTORY_NAME);
    /* eg: /workspace/aa/bb/cc/object-1/v1/inventory.json.sha512 */
    let invDigestPath = invPath + '.' + digestAlgorithm;

    // calculate digest
    const inventoryContent = inventory.toString();
    let digest = (await OcflDigest.digest(digestAlgorithm, inventoryContent)) + ' ' + INVENTORY_NAME;

    // write inventory.json to workspace
    await this._store.writeFile(invPath, inventoryContent);
    await this._store.writeFile(invDigestPath, digest);
    if (workspaceVersionPath !== objectVersionPath) {
      try {
        await this._object._ensureNamaste();
        await this._store.move(workspaceVersionPath, objectVersionPath);
        await this._store.remove(this._createdDir);
      } catch (error) {
        await this.rollback();
        throw error;
      }
    }
    // replace root inventory
    /* eg: /data/aa/bb/cc/object-1/inventory.json */
    const rootInvPath = path.join(this._object.root, INVENTORY_NAME);
    /* eg: /data/aa/bb/cc/object-1/v1/inventory.json */
    invPath = path.join(objectVersionPath, INVENTORY_NAME);
    invDigestPath = invPath + '.' + digestAlgorithm;
    let rootInvDigestPath = rootInvPath + '.' + digestAlgorithm;
    await this._store.copyFile(invPath, rootInvPath + '.tmp');
    await Promise.all([
      this._store.move(rootInvPath + '.tmp', rootInvPath),
      this._store.copyFile(invDigestPath, rootInvDigestPath)]);

  }

  /**
   * 
   * @param {string} logicalPath 
   * @param {Object} options
   * @return {Promise<WritableStream>} 
   */
  async createWritable(logicalPath, options) {
    if (this._committed) throw new Error('Transaction already commited');
    const digestAlgo = this._inventory.digestAlgorithm;
    const digestAlgos = [digestAlgo, ...(this._object.fixity || [])];
    const hs = await OcflDigest.createStream(digestAlgos);
    const realPath = this._getRealPath(logicalPath);
    const writer = (await this._store.createWritable(realPath, options)).getWriter();
    //const hs = await OcflDigest.createStream(this._inventory.digestAlgorithm);
    const inv = this._inventory;
    const store = this._store;
    const ws = new WritableStream({
      write(chunk, controller) {
        hs.update(chunk);
        return writer.write(chunk);
      },
      async close() {
        await writer.close();
        //const digest = hs.digest('hex');
        const {[digestAlgo]: digest, ...fixity} = hs.digest();
        if (inv.getContentPath(digest)) await store.remove(realPath);
        inv.add(logicalPath, digest, fixity);
      }
    });
    /** @type {Promise<any> & { done?: boolean }} */
    const p = writer.closed;
    p.finally(() => { p.done = true; });
    this._queue.push(p);

    return ws;
  }

  async write(logicalPath, data, options) {
    return this._transact(async () => {
      let realPath = this._getRealPath(logicalPath);
      const digestAlgo = this._inventory.digestAlgorithm;
      const digestAlgos = [digestAlgo, ...(this._object.fixity || [])];
      let digest, fixity;
      if (typeof data === 'string' || ArrayBuffer.isView(data)) {
        // if data is not stream, check digest first
        if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Uint32Array)) {
          data = new Uint8Array(data.buffer)
        }
        const test = await OcflDigest.digest(digestAlgos, data);
        ({[digestAlgo]: digest, ...fixity} = test);
        if (!this._inventory.getContentPath(digest)) {
          // no digest yet, write the file to storage backend
          await this._store.writeFile(realPath, data, options);
        }
      } else if (data instanceof ReadableStream) {
        // save the stream first
        const hs = await OcflDigest.createStreamThrough(digestAlgos);
        const rs = data.pipeThrough(hs);
        await this._store.writeFile(realPath, rs, options);
        ({[digestAlgo]: digest, ...fixity} = hs.digest());
        // already exists, delete temp file
        if (this._inventory.getContentPath(digest)) await this._store.remove(realPath);
      } else {
        throw new TypeError('Unsupported data type ', data);
      }
      this._inventory.add(logicalPath, digest, fixity);
      // console.log(this._inventory.toString());
    });
  }

  /**
   * Import a single file from source. This is a helper method for {@link OcflObjectTransaction.import | import()} method.
   * @param {*} source 
   * @param {*} target 
   */
  async importFile(source, target) {
    if (!target) throw new TypeError('Target logical path must not be empty if source is a file.');
    const realPath = this._getRealPath(target);
    const rs = await this._store.createReadable(source);
    const digestAlgo = this._inventory.digestAlgorithm;
    const digestAlgos = [digestAlgo, ...(this._object.fixity || [])];
    const {[digestAlgo]: digest, ...fixity} = await OcflDigest.digest(digestAlgos, rs);

    if (!this._inventory.getContentPath(digest)) {
      await this._store.copyFile(source, realPath);
    }
    this._inventory.add(target, digest, fixity);
  }

  async import(source, target) {
    return this._transact(async () => {
      target = target ?? path.basename(source);
      let srcStat = await this._store.stat(source);
      if (srcStat.isFile()) {
        await this.importFile(source, target);
      } else if (srcStat.isDirectory()) {
        const files = await this._store.readdir(source);
        await parallelize(files, async (filename) => {
          await this.import(path.join(source, filename), path.join(target, filename));
        });
      }
    });
  }

  async copy(source, target) {
    return this._transact(async () => {
      return this._inventory.copy(source, target);
    });
  }

  async rename(source, target) {
    return this._transact(async () => {
      // if file already exists in the workspace, rename the actual file
      try {
        let realSource = this._getRealPath(source);
        let realTarget = this._getRealPath(target);
        await this._store.move(realSource, realTarget);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return this._inventory.rename(source, target);
    });
  }

  async reinstate(logicalPath, versionName) {
    //let digest = this._inventory.getDigestFromLogical(logicalPath);
    let count = this._inventory.reinstate(logicalPath, versionName);
    // if (count) {
    //   // ensure no existing file with the same logical path in the workspace
    //   try {
    //     await this._store.remove(this._getRealPath(logicalPath));
    //   } catch (error) {
    //     if (error.code !== 'ENOENT') throw error;
    //   }
    // }
    return count;
  }

  async remove(logicalPath, options) {
    return this._transact(async () => {
      if (options?.purge) {
        // completely remove content from all versions
        let ver = this._inventory.prevVersion;
        while (ver) {
          this._inventory.currentVersion = ver;
          this._inventory.delete(logicalPath);
          await this._store.remove(this._getRealPath(logicalPath));
          ver = this._inventory.prevVersion;
        }
        this._inventory.currentVersion = this._inventory.head;
      }
      if (this._inventory.delete(logicalPath)) {
        return this._store.remove(this._getRealPath(logicalPath));
      }
    });
  }

  /**
   * A function wrapper to provide safe mutating operation that 
   * will check if a transaction is already committed and track any unfinished promises. 
   * @template T
   * @param {() => Promise<T>} op
   */
  async _transact(op) {
    if (this._committed) throw new Error('Transaction already commited');
    /** @type {Promise<any> & { done?: boolean }} */
    const p = op();
    p.finally(() => { p.done = true; });
    this._queue.push(p);
    return p;
  }

}

module.exports = {
  OcflObjectTransaction,
  OcflObjectTransactionImpl
};
