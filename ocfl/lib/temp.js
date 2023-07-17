const fs = require('fs-extra');
const path = require('path');
const hasha = require('hasha');
const _ = require('lodash');
const DIGEST_ALGORITHM = 'sha512';

class OcflObject {


  constructor(path) {
    this.path = path;
    this.ocflVersion = '1.0';
    this.contentVersion = null; // No content yet
    this.id = null; // Not set yet
    this.DIGEST_ALGORITHM = DIGEST_ALGORITHM;

  }

  async writeInventories(inv, version) {
    const main_inv = await fs.writeJson(path.join(this.path, 'inventory.json'), inv, { spaces: 2 });
    const version_inv = await fs.writeJson(path.join(this.path, version, 'inventory.json'), inv, { spaces: 2 });
    const inv_hash = await this.hash_file(path.join(this.path, 'inventory.json'))
    const digest_file_v1 = await fs.writeFile(path.join(this.path, version, 'inventory.json.' + DIGEST_ALGORITHM), inv_hash + "   inventory.json");
    const digest_file = await fs.writeFile(path.join(this.path, 'inventory.json.' + DIGEST_ALGORITHM), inv_hash + "   inventory.json");

  }

  // addContent is passed an id and a callback - this takes one argument, the
  // directory into which content is to be written.
  // This is called for both new and merged versions: the incoming version is
  // written as v1 of a new object in the deposit directory, and if it's not the
  // first version it's then merged with the existing most recent version

  async addContent(id, writeContent) {
    // Copy files into v1

    const version = "v1" // Always a fresh start as we're not touching an existing repo object
    const versionPath = path.join(this.path, version, "content");
    await fs.ensureDir(versionPath);
    await writeContent(versionPath);

    // Make an inventory
    const inv = await this.inventory(id, versionPath);

    // Put the inventory in the root AND version dir
    await this.writeInventories(inv, version)
    this.contentVersion = await this.determineVersion();
    this.id = id;
  }

  // preserving the old interface here

  async importDir(id, sourceDir) {
    await this.addContent(id, async (targetDir) => {
      await fs.copy(sourceDir, targetDir);
    })
  }


  async create(path) {
    // Creates a blank object with a content dir but no content at <path>
    if (this.path) {
      throw new Error("This object has already been initialized at: " + this.path)
    }
    this.path = path;
    const stats = await fs.stat(this.path);
    if (await fs.pathExists(this.path) && stats.isDirectory()) {
      const readDir = await fs.readdir(this.path);
      if (readDir.length <= 0) { // empty so initialise an object here
        const generateNamaste = await this.generateNamaste(this.path, this.ocflVersion);
      } else {
          throw new Error('can\'t initialise an object here as there are already files')
        }
    } else {
      //else if it doesnt it dies
      throw new Error('directory does not exist');
    }
  }

  async load(path) {
    // Tries to load an existing object residing at <path>
    if (this.path) {
      throw new Error("This object has already been initialized at: " + this.path)
    }
    this.path = path;
    const stats = await fs.stat(this.path);
    if (await fs.pathExists(this.path) && stats.isDirectory()) {
    
        const ocflVersion = await this.isObject(this.path);
        if (!ocflVersion) {
          throw new Error('can\'t initialise an object here as there are already files')
        }
    } else {
      throw new Error(path + ' does not exist or is not a directory');
    }
  }

  getVersionString(i) {
    // Make a version name as per the SHOULD in the spec v1..vn
    // TODO have an option for zero padding
    return "v" + i
  }

  async getInventory() {
    const inventoryPath = path.join(this.path, "inventory.json");
    if (fs.existsSync(inventoryPath)) {
      return await JSON.parse(fs.readFileSync(inventoryPath).toString());
    }
    else {
      return null;
    }
  }

  async determineVersion() {
    const inv = await this.getInventory();
    if (inv) {
      return inv.head;
    }
    else {
      return null;
    }
    // Here's not how to do it: 
    /* var version = 0;
    const dirContents = await fs.readdir(this.path);
    for (let f of dirContents.filter(function(d){return d.match(/^v\d+$/)})){    
        const v =  parseInt(f.replace("v",""));
        if (v > version) {
            version = v;
        }
    }
    return version;10. */
    // Look at each dir that matches v\d+

  }

  async isObject(aPath) {
    // TODO: Check if this content root with NAMASTE and returns ocfl version
    // 0=ocfl_object_1.0
    // looks at path and see if the content of the file is
    // TODO: Make this look for a namaste file beginning with 0=ocfl_object_ and extract the version
    const theFile = path.join(aPath, "0=" + this.nameVersion(this.ocflVersion));
    return await fs.pathExists(theFile);
  }

  nameVersion(version) {
    return 'ocfl_object_' + version;
  }

  async generateNamaste(aPath, version) {
    const fileName = '0=' + this.nameVersion(version);
    const thePath = path.join(aPath, fileName);
    const writeFile = await fs.writeFile(thePath, this.nameVersion(version));
    const contentDir = await fs.mkdir(path.join(aPath, "v1"));
  }


  async digest_dir(dir) {
    var items = {};
    const contents = await fs.readdir(dir);
    items = _.flatten(await Promise.all(contents.map(async (p1) => {
      const p = path.join(dir, p1);
      const stats = await fs.stat(p);
      if (stats.isDirectory()) {
        return await this.digest_dir(p);
      } else {
        const h = await this.hash_file(p);
        return [p, h];
      }
    })));
    return items;
  }

  async hash_file(p) {
    const hash = await hasha.fromFile(p, { algorithm: DIGEST_ALGORITHM })
    return hash;
  }


  async removeEmptyDirectories(folder) {
    // Remove empty directories
    // Adapted (nade async) from: https://gist.github.com/jakub-g/5903dc7e4028133704a4
    if (!folder) {
      folder = this.path;
    }
    const stats = await fs.stat(folder);
    var isDir = await stats.isDirectory();
    if (isDir) {
      var files = await fs.readdir(folder);
      if (files.length > 0) {
        for (let f of files) {
          var fullPath = path.join(folder, f);
          await this.removeEmptyDirectories(fullPath);
        }
        files = await fs.readdir(folder);
      }
      if (files.length == 0) {
        const rm = await fs.rmdir(folder);
        return;
      }
    }
  }

  async inventory(id, dir) {
    const versionId = "v1";
    const inv = {
      'id': id,
      'type': 'https://ocfl.io/1.0/spec/#inventory',
      'digestAlgorithm': DIGEST_ALGORITHM,
      'head': versionId,
      'versions': {

      }
    };
    inv.versions[versionId] = {
      "created": new Date().toISOString(),
      "state": {}
    }
    // TODO Message and state keys in version
    var hashpairs = await this.digest_dir(dir);
    var versionState = inv.versions[versionId].state;
    inv['manifest'] = {};
    for (let i = 0; i < hashpairs.length; i += 2) {
      const thisHash = hashpairs[i + 1]
      const thisPath = path.relative(this.path, hashpairs[i])
      const versionPath = path.relative(path.join("v1", "content"), thisPath)
      if (!inv['manifest'][thisHash]) {
        //Store only ONE path
        inv['manifest'][thisHash] = [thisPath]
      }
      else {
        // TODO DELETE THIS FILE FROM THE OBJECT BEFORE WE STORE IT
      }

      if (versionState[thisHash]) {
        // Store all 
        versionState[thisHash].push(versionPath)
      }
      else {
        versionState[thisHash] = [versionPath]

      }

    }
    return inv
  }

  async getFilePath(filePath, version) {
    const inv = await this.getInventory();
    if (!version) {
      version = inv.head;
    }
    const state = inv.versions[version].state;
    for (let hash of Object.keys(state)) {
      const aPath = state[hash];
      const findPath = _.find(aPath, (p) => p === filePath);
      if (findPath) {
        return inv.manifest[hash][0];
      }
    }
    throw new Error('cannot find file');
  }

}
