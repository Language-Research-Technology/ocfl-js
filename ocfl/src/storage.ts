//@todo add default layout
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { NotImplementedError, OcflError } from './error.ts';
import { createByName, OcflStorageLayout } from './extension.ts';
import { HashedNTupleStorageLayout } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
import { OcflObject } from './object.ts';
import { findNamasteVersion, isDirEmpty } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, OCFL_VERSIONS, OCFL_LAYOUT, EXTENSIONS_DIR, EXTENSION_CONFIG, NAMASTE_PREFIX_STORAGE, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

import { OcflDigest } from './digest.ts';

const DEFAULT_LAYOUT = HashedNTupleStorageLayout;

import type { OcflStore } from './store.ts';
import type { OcflExtensionConfig, OcflObjectConfig, OcflStorageConfig, OcflVersion } from './types.ts';

/**
 * An abstraction to represent the OCFL Storage Root, which is
 * a base directory used to store OCFL Objects, identified by a [NAMASTE] file “0=ocfl_1.1”.
 */

class OcflStorage {
  ocflVersion: OcflVersion = OCFL_VERSION;

  /**
   * Get the storage root
   */
  get root(): string {
    throw new NotImplementedError();
  }

  /**
   * Construct the path of the object root relative to the storage root
   * The path is mapped from the object identifier using the algorithm defined in the chosen
   * storage layout extension (specified in {@link OcflStorageConfig}).
   * @param id - Identifier of the object
   */
  objectRoot(_id: string): string {
    throw new NotImplementedError();
  }

  /**
   * Absolute path to the object root
   * @param id - Identifier of the object
   */
  objectRootAbs(id: string) {
    return path.join(this.root, this.objectRoot(id));
  }

  /**
   * Get an existing object in the Storage or create a new one.
   * @param opt - A unique identifier for the OCFL Object, should be a URI
   */
  object(_opt: string | { id?: string | undefined; root?: string | undefined }): OcflObject {
    throw new NotImplementedError();
  }

  /**
   * Check if the storage has already the object with the given id.
   */
  async has(id: string) {
    return this.object(id).exists();
  }

  /**
   * Create the storage root in the underlying storage backend
   * @param options - Additional options for creating storage root
   */
  async create(_options?: { ocflSpecText?: boolean | undefined }): Promise<OcflStorage> {
    throw new NotImplementedError();
  }

  /**
   * Check namaste, retrieve storage layout extension, and read its config file.
   */
  async load(): Promise<OcflStorage> {
    throw new NotImplementedError();
  }

  /**
   * Check if the storage root path points to an existing file or non-empty directory in the underlying backend store.
   * The existing directory may or may not be a valid OCFL Storage.
   */
  async exists(): Promise<boolean> {
    throw new NotImplementedError();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<OcflObject> {
    throw new NotImplementedError();
  }

  /**
   * Return a new AsyncIterator that contains all the OCFL objects in this Storage.
   */
  objects(): AsyncIterableIterator<OcflObject> {
    return this[Symbol.asyncIterator]();
    // const objects = [];
    // for await (const o of this) objects.push(o);
    // return objects;
  }

  async delete(id: string) {
    return this.remove(id);
  }

  async purge(id: string) {
    return this.remove(id);
  }

  async remove(_id: string): Promise<void> {
    throw new NotImplementedError();
  }
}

/**
 * General implementation of {@link OcflStorage} that can uses different datastore backends.
 * This class provides common functionalities for the subclasses and
 * at the same provide encapsulation emulating private and protected methods.
 */
class OcflStorageImpl extends OcflStorage {
  #root: string;
  #workspace: string;
  #layout: OcflStorageLayout | undefined;
  #store: OcflStore;
  #objectConfig: Omit<OcflObjectConfig, 'root' | 'workspace' | 'id' | 'ocflVersion'>;
  #configuredOcflVersion: OcflVersion | undefined;

  constructor(config: OcflStorageConfig, store: OcflStore) {
    super();
    if (!store) {
      throw new TypeError('[OcflStorage] store is required.');
    }
    if (!config.root) {
      throw new TypeError('[OcflStorage] config.root is required.');
    }
    this.#store = store;
    const { root, workspace, layout, ocflVersion, ...objectConfig } = config;
    this.#root = path.resolve(root);
    this.#workspace = workspace ? path.resolve(workspace) : path.join(this.#root, 'extensions/workspace');
    if (this.#workspace?.startsWith(this.#root + path.sep) && !this.#workspace.startsWith(`${this.#root + path.sep}extensions${path.sep}`)) {
      throw new Error('[OcflStorage] config.workspace cannot be the same as or a subpath of config.root');
    }
    if (layout) {
      this.#layout = layout instanceof OcflStorageLayout ? layout : this.#createLayout(layout);
    }
    if (ocflVersion) {
      this.ocflVersion = ocflVersion;
    }
    this.#configuredOcflVersion = ocflVersion;
    this.#objectConfig = objectConfig;
  }

  #createLayout(option: OcflExtensionConfig | string | undefined) {
    const name = typeof option === 'string' ? option : option?.extensionName;
    const config = typeof option === 'object' ? option : undefined;
    if (name) {
      return createByName<OcflStorageLayout>(OcflStorageLayout, 'Layout', name, config);
    }
    // else if (useDefault) {
    //   return DEFAULT_LAYOUT.create(config);
    // }
  }

  get root() {
    return this.#root;
  }

  objectRoot(id: string) {
    if (!this.#layout) {
      throw new Error('[OcflStorage] No layout defined');
    }
    return this.#layout.map(id);
  }

  /**
   * The root param is a relative path to the storage root.
   */
  object(opt: string | { id?: string | undefined; root?: string | undefined }) {
    let id: string | undefined;
    let root: string | undefined;
    if (typeof opt === 'string') {
      id = opt;
    } else {
      ({ id, root } = opt);
    }
    const relObjectRoot = root || (id && this.objectRoot(id));
    if (!relObjectRoot) {
      throw new TypeError('[OcflStorage] object id or root is required.');
    }
    return new OcflObject(
      {
        id,
        root: path.join(this.root, relObjectRoot),
        // @todo:use extension workspace if not defined
        workspace: this.#workspace ? path.join(this.#workspace, relObjectRoot) : undefined,
        ocflVersion: this.ocflVersion,
        ...this.#objectConfig,
      },
      this.#store,
    );
  }

  async exists() {
    return !(await isDirEmpty(this.#store, this.root));
  }

  async load() {
    const prefix = NAMASTE_PREFIX_STORAGE;
    const [ocflVersion, layout] = (
      await Promise.allSettled([findNamasteVersion(this.#store, prefix, this.root), this.#store.readFile(path.join(this.root, OCFL_LAYOUT), 'utf8')])
    ).map((r) => (r.status === 'fulfilled' ? r.value : undefined));
    if (ocflVersion === '') {
      throw createError('E080', this.root);
    }
    if (!ocflVersion) {
      throw createError('E069', this.root);
    }
    const rootVersion = ocflVersion as OcflVersion;
    const configured = this.#configuredOcflVersion;
    // OCFL_VERSIONS is ordered newest first
    if (configured && OCFL_VERSIONS.indexOf(configured) < OCFL_VERSIONS.indexOf(rootVersion)) {
      throw createError('E081', this.root, `configured ocflVersion ${configured} is later than the storage root's ${rootVersion}`);
    }
    this.ocflVersion = configured ?? rootVersion;
    let layoutName: string | undefined;
    let layoutConfig: OcflExtensionConfig | undefined;
    // load layout
    try {
      if (layout) {
        layoutName = JSON.parse(layout).extension;
      }
    } catch (_error) {}
    // load ext config if exists
    if (layoutName) {
      try {
        const cfgstr = await this.#store.readFile(path.join(this.root, EXTENSIONS_DIR, layoutName, EXTENSION_CONFIG), 'utf8');
        layoutConfig = JSON.parse(cfgstr as string);
      } catch (_error) {}
    }
    this.#layout = this.#createLayout(layoutConfig || layoutName);
    const layoutDigestAlgorithm = this.#layout?.get('digestAlgorithm');
    if (layoutDigestAlgorithm) {
      await OcflDigest.initSync(layoutDigestAlgorithm);
    }
    //@todo: load storage level extensions

    return this;
  }

  /**
   * @param options - Additional options for creating storage root
   */
  async create(options?: { ocflSpecText?: boolean | undefined }) {
    if (await this.exists()) {
      //cannot create, storage root already exists .
      throw new OcflError('DIRECTORY_NOT_EMPTY', '[OcflStorage] Cannot create storage root in a non-empty directory');
    } else {
      await this.#store.mkdir(this.root);
    }
    // create namaste
    const prefix = NAMASTE_PREFIX_STORAGE;
    const filenamePrefix = NAMASTE_T + prefix;
    const filePath = path.join(this.root, filenamePrefix + this.ocflVersion);
    await this.#store.writeFile(filePath, `${prefix + this.ocflVersion}\n`, 'utf8');

    // create layout
    if (!this.#layout) {
      this.#layout = new DEFAULT_LAYOUT();
    }
    const layoutDigestAlgorithm = this.#layout.get('digestAlgorithm');
    if (layoutDigestAlgorithm) {
      await OcflDigest.initSync(layoutDigestAlgorithm);
    }
    const layout = { extension: this.#layout.name, description: this.#layout.description };
    await this.#store.writeFile(path.join(this.root, OCFL_LAYOUT), JSON.stringify(layout, null, 2), 'utf8');
    if (this.#layout.config) {
      await this.#store.writeFile(
        path.join(this.root, EXTENSIONS_DIR, this.#layout.name, EXTENSION_CONFIG),
        JSON.stringify(this.#layout.config, null, 2),
        'utf8',
      );
    }

    // todo: create other extensions
    if (options?.ocflSpecText) {
    }
    return this;
  }

  /**
   * Allow async iteration over all OCFL objects in this storage.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<OcflObject> {
    const store = this.#store;
    const workspace = this.#workspace;
    const config = this.#objectConfig;
    const root = this.root;
    const stack = [this.#store.opendir(this.root)];
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<OcflObject>> {
        for (let dirp = stack.pop(); dirp; dirp = stack.pop()) {
          const dir = await dirp;
          const dirent = await dir.read();
          if (!dirent) {
            await dir.close();
            continue;
          }
          stack.push(dirp);
          if (!dirent.isDirectory()) {
            continue;
          }
          const basePath = path.join(dir.path, dirent.name);
          let nv: OcflVersion | '' | undefined;
          try {
            nv = await findNamasteVersion(store, NAMASTE_PREFIX_OBJECT, basePath);
          } catch (_err) {}
          if (nv) {
            //ocfl object exists
            // inventory exists
            const object = new OcflObject(
              {
                root: basePath,
                workspace: workspace ? path.join(workspace, path.relative(root, basePath)) : undefined,
                ocflVersion: nv,
                ...config,
              },
              store,
            );
            //await object.load();
            return { done: false, value: object };
          } else {
            //ocfl object does not exist, process subdir
            stack.push(store.opendir(basePath));
          }
        }
        return { done: true, value: null };
      },
      // return() {
      //   return { done: true };
      // }
    };
  }
}

export { OcflStorage, OcflStorageImpl };
