import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import { ObjectNotFoundError, OcflError } from './error.ts';
import type { BuiltInLayout } from './extension.ts';
import { HashedNTupleStorageLayout } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
import { createLayout } from './extensions/index.ts';
import { OcflObject } from './object.ts';
import { checkedObjectPath, mappedObjectPath, readSpecText, readStorageRoot, updateTarget, writeStorageRoot } from './storage-root.ts';
import * as store from './store.ts';
import type { OcflObjectConfig, OcflStorageConfig, OcflVersion } from './types.ts';
import { findNamasteVersion, isDirEmpty } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, EXTENSIONS_DIR, NAMASTE_PREFIX_OBJECT } = OcflConstants;

const DEFAULT_LAYOUT = HashedNTupleStorageLayout;

/**
 * An abstraction to represent the OCFL Storage Root, which is
 * a base directory used to store OCFL Objects, identified by a [NAMASTE] file “0=ocfl_1.1”.
 */
class OcflStorage {
  ocflVersion: OcflVersion = OCFL_VERSION;
  #root: string;
  #layout: BuiltInLayout | undefined;
  #objectConfig: Omit<OcflObjectConfig, 'root' | 'storageRoot' | 'workspace' | 'id' | 'ocflVersion'>;

  constructor(config: OcflStorageConfig) {
    if (!config.root) {
      throw new TypeError('[OcflStorage] config.root is required.');
    }
    const { root, layout, ...objectConfig } = config;
    this.#root = path.resolve(root);
    if (layout !== undefined) {
      this.#layout = createLayout(layout);
    }
    this.#objectConfig = objectConfig;
  }

  /**
   * Get the storage root
   */
  get root(): string {
    return this.#root;
  }

  /**
   * Construct the path of the object root relative to the storage root
   * The path is mapped from the object identifier using the algorithm defined in the chosen
   * storage layout extension (specified in {@link OcflStorageConfig}).
   * @param id - Identifier of the object
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id, or maps it to the storage root, outside it, or into its extensions directory
   */
  objectRoot(id: string): string {
    const objectRoot = this.#requireLayout().map(id);
    checkedObjectPath(this.root, objectRoot, `The object id <${id}>`);
    return objectRoot;
  }

  #requireLayout(): BuiltInLayout {
    if (!this.#layout) {
      throw new Error('[OcflStorage] No layout defined');
    }
    return this.#layout;
  }

  /**
   * Get an existing object in the Storage or create a new one.
   * The root param is a relative path to the storage root.
   * @param opt - A unique identifier for the OCFL Object, should be a URI
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the id or root maps to the storage root, outside it, or into its extensions directory
   */
  object(opt: string | { id?: string | undefined; root?: string | undefined }): OcflObject {
    let id: string | undefined;
    let root: string | undefined;
    if (typeof opt === 'string') {
      id = opt;
    } else {
      ({ id, root } = opt);
    }
    let relative: string;
    if (root) {
      relative = checkedObjectPath(this.root, root, 'The object root');
    } else if (id) {
      relative = mappedObjectPath(this.root, this.#requireLayout(), id);
    } else {
      throw new TypeError('[OcflStorage] object id or root is required.');
    }
    return new OcflObject({
      ...this.#objectConfig,
      id,
      ...updateTarget(this.root, path.join(this.root, relative), this.ocflVersion),
    });
  }

  /**
   * Check if the storage has already the object with the given id.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` as {@link OcflStorage.object} does
   */
  async has(id: string): Promise<boolean> {
    return this.object(id).exists();
  }

  /**
   * Check if the storage root path points to an existing file or non-empty directory.
   * The existing directory may or may not be a valid OCFL Storage.
   */
  async exists(): Promise<boolean> {
    return !(await isDirEmpty(this.root));
  }

  /**
   * Check namaste, retrieve storage layout extension, and read its config file.
   * The layout is always the storage root's own, and a configured layout is ignored: a root with no `ocfl_layout.json` loads with no layout.
   * @throws `ValidationError` `E069` if the storage root has no declaration, `E080` if its declaration is invalid.
   * @throws `ValidationError` `E070` if `ocfl_layout.json` has no string `extension`.
   * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if `ocfl_layout.json` names a layout this library doesn't implement.
   * @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if the layout's `config.json` isn't a JSON object or has parameters the layout rejects.
   * @throws The file system error if the storage root declaration, `ocfl_layout.json` or the layout's `config.json` exists but can't be read.
   */
  async load(): Promise<OcflStorage> {
    const { ocflVersion, layout } = await readStorageRoot(this.root);
    this.ocflVersion = ocflVersion;
    this.#layout = layout;
    return this;
  }

  /**
   * Create the storage root on the filesystem
   * @param options - Additional options for creating storage root. `ocflSpecText` writes a human-readable copy of the OCFL spec for this root's version
   * into the root
   */
  async create(options?: { ocflSpecText?: boolean | undefined }): Promise<OcflStorage> {
    if (await this.exists()) {
      //cannot create, storage root already exists .
      throw new OcflError('DIRECTORY_NOT_EMPTY', '[OcflStorage] Cannot create storage root in a non-empty directory');
    }
    // read before the first write: a failed create can't be retried once the root is non-empty
    const specText = options?.ocflSpecText ? await readSpecText(this.ocflVersion) : undefined;
    this.#layout ??= new DEFAULT_LAYOUT();
    await writeStorageRoot(this.root, this.ocflVersion, this.#layout, specText);
    return this;
  }

  /**
   * Delete an object and any version a failed update left in its workspace.
   * Parent directories left empty are removed too, up to but not including the storage root.
   * Not guarded against a concurrent update of the object.
   * @param id - Identifier of the object
   * @throws {@link ObjectNotFoundError} If the object does not exist.
   * @throws {@link OcflError} `NOT_AN_OBJECT` if the path holds something with no OCFL object declaration; nothing is deleted.
   */
  async remove(id: string): Promise<void> {
    const object = this.object(id);
    const objectRoot = object.root;
    if (!(await object.exists())) {
      throw new ObjectNotFoundError(id);
    }
    const declaredVersion = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, objectRoot);
    if (declaredVersion === '') {
      throw createError('E007', objectRoot);
    }
    if (!declaredVersion) {
      throw new OcflError('NOT_AN_OBJECT', `"${objectRoot}" has no OCFL object declaration, so nothing was deleted.`);
    }
    await object._validateObjectPath();
    // A layout can map several ids to one path, such as path-direct with omitScheme mapping http: and https: ids together
    const inventory = await object.getInventory();
    if (inventory?.id !== id) {
      throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `"${objectRoot}" holds the object <${inventory?.id}>, not <${id}>, so nothing was deleted.`);
    }
    // Workspace first, so if it can't be removed the object survives and remove can be retried
    await fs.promises.rm(object._workspace, { recursive: true, force: true });
    await fs.promises.rm(objectRoot, { recursive: true, force: true });
    // The object is gone, so a retry would throw ObjectNotFoundError; a leftover empty directory is harmless
    for (const dir of [object._workspace, objectRoot]) {
      await store.removeEmptyAncestors(path.dirname(dir), this.root).catch(() => {});
    }
  }

  /**
   * Allow async iteration over all OCFL objects in this storage.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<OcflObject> {
    return this.#objectsUnder(this.root);
  }

  async *#objectsUnder(dirPath: string): AsyncGenerator<OcflObject> {
    for await (const dirent of await fs.promises.opendir(dirPath)) {
      if (!dirent.isDirectory() || (dirPath === this.root && dirent.name === EXTENSIONS_DIR)) {
        continue;
      }
      const basePath = path.join(dirPath, dirent.name);
      const nv = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, basePath);
      if (nv) {
        yield new OcflObject({
          ...this.#objectConfig,
          ...updateTarget(this.root, basePath, nv),
        });
      } else {
        yield* this.#objectsUnder(basePath);
      }
    }
  }
}

export { OcflStorage };
