//@todo add default layout
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { OcflConstants } from './constants.ts';
import { ObjectNotFoundError, OcflError } from './error.ts';
import type { BuiltInLayout, OcflExtensionConfig } from './extension.ts';
import { HashedNTupleStorageLayout } from './extensions/0004-hashed-n-tuple-storage-layout.ts';
import { createLayout, supportedLayoutClass } from './extensions/index.ts';
import { OcflObject } from './object.ts';
import * as store from './store.ts';
import { findNamasteVersion, isDirEmpty, parseJsonObject, readIfExists } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, OCFL_VERSIONS, OCFL_LAYOUT, EXTENSIONS_DIR, EXTENSION_CONFIG, NAMASTE_PREFIX_STORAGE, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;

const DEFAULT_LAYOUT = HashedNTupleStorageLayout;

import type { OcflObjectConfig, OcflStorageConfig, OcflVersion } from './types.ts';

const SPEC_TEXT_FILES: Record<OcflVersion, string> = { '1.0': 'ocfl_1.0.txt', '1.1': 'ocfl_1.1.md' };

async function readSpecText(ocflVersion: OcflVersion) {
  const file = SPEC_TEXT_FILES[ocflVersion];
  return { file, content: await fs.promises.readFile(new URL(`../resources/${file}`, import.meta.url)) };
}

/** @throws `ValidationError` `E070` if `content` has no string `extension` */
function declaredLayoutName(file: string, content: string): string {
  const extension = parseJsonObject(content)?.extension;
  if (typeof extension !== 'string') {
    throw createError('E070', file, 'it has no string extension');
  }
  return extension;
}

/** @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if `content` isn't a JSON object */
function parseLayoutConfig(file: string, content: string): OcflExtensionConfig {
  const config = parseJsonObject(content);
  if (!config) {
    throw new OcflError('INVALID_LAYOUT_CONFIG', `The layout config ${file} is not a JSON object.`);
  }
  return config;
}

/**
 * An abstraction to represent the OCFL Storage Root, which is
 * a base directory used to store OCFL Objects, identified by a [NAMASTE] file “0=ocfl_1.1”.
 */
class OcflStorage {
  ocflVersion: OcflVersion = OCFL_VERSION;
  #root: string;
  #workspace: string;
  #layout: BuiltInLayout | undefined;
  #configuredLayout: BuiltInLayout | undefined;
  #objectConfig: Omit<OcflObjectConfig, 'root' | 'workspace' | 'id' | 'ocflVersion'>;
  #configuredOcflVersion: OcflVersion | undefined;

  constructor(config: OcflStorageConfig) {
    if (!config.root) {
      throw new TypeError('[OcflStorage] config.root is required.');
    }
    const { root, workspace, layout, ocflVersion, ...objectConfig } = config;
    this.#root = path.resolve(root);
    this.#workspace = workspace ? path.resolve(workspace) : path.join(this.#root, 'extensions/workspace');
    if (this.#workspace?.startsWith(this.#root + path.sep) && !this.#workspace.startsWith(`${this.#root + path.sep}extensions${path.sep}`)) {
      throw new Error('[OcflStorage] config.workspace cannot be the same as or a subpath of config.root');
    }
    if (layout !== undefined) {
      this.#configuredLayout = createLayout(layout);
      this.#layout = this.#configuredLayout;
    }
    if (ocflVersion) {
      this.ocflVersion = ocflVersion;
    }
    this.#configuredOcflVersion = ocflVersion;
    this.#objectConfig = objectConfig;
  }

  #resolveLayout(declaredName: string | undefined, rootLayoutConfig: OcflExtensionConfig | undefined) {
    const configured = this.#configuredLayout;
    if (declaredName === undefined) {
      return configured;
    }
    const rootName = configured ? declaredName : (rootLayoutConfig?.extensionName ?? declaredName);
    const rootLayoutClass = supportedLayoutClass(rootName);
    if (configured && configured.name !== rootName) {
      throw new OcflError('LAYOUT_MISMATCH', `Configured layout "${configured.name}" differs from the storage root's layout "${rootName}".`);
    }
    if (!configured) {
      return new rootLayoutClass(rootLayoutConfig);
    }
    // config.json can't hold a RegExp, so the configured layout is compared with it as stored rather than rebuilt from it
    const differences = configured.differencesFromStored(rootLayoutConfig);
    if (differences.length === 0) {
      return configured;
    }
    const rootParameters = new rootLayoutClass(rootLayoutConfig).parameters as OcflExtensionConfig;
    const mismatches = differences.map(
      (name) => `configured ${name}: ${inspect((configured.parameters as OcflExtensionConfig)[name])}, root ${name}: ${inspect(rootParameters[name])}`,
    );
    throw new OcflError('LAYOUT_MISMATCH', `Configured layout "${configured.name}" differs from the storage root's: ${mismatches.join('; ')}.`);
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
   */
  objectRoot(id: string): string {
    if (!this.#layout) {
      throw new Error('[OcflStorage] No layout defined');
    }
    return this.#layout.map(id);
  }

  /**
   * Get an existing object in the Storage or create a new one.
   * The root param is a relative path to the storage root.
   * @param opt - A unique identifier for the OCFL Object, should be a URI
   */
  object(opt: string | { id?: string | undefined; root?: string | undefined }): OcflObject {
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
    return new OcflObject({
      id,
      root: path.join(this.root, relObjectRoot),
      // @todo:use extension workspace if not defined
      workspace: this.#workspace ? path.join(this.#workspace, relObjectRoot) : undefined,
      ocflVersion: this.ocflVersion,
      ...this.#objectConfig,
    });
  }

  /**
   * Check if the storage has already the object with the given id.
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
   * @throws `ValidationError` `E070` if `ocfl_layout.json` exists but has no string `extension`.
   * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if `ocfl_layout.json` names a layout this library doesn't implement.
   * @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if the layout's `config.json` isn't a JSON object or has parameters the layout rejects.
   * @throws The file system error if `ocfl_layout.json` or the layout's `config.json` exists but can't be read.
   */
  async load(): Promise<OcflStorage> {
    const prefix = NAMASTE_PREFIX_STORAGE;
    const layoutPath = path.join(this.root, OCFL_LAYOUT);
    const [namaste, layoutRead] = await Promise.allSettled([findNamasteVersion(prefix, this.root), readIfExists(layoutPath)]);
    const ocflVersion = namaste.status === 'fulfilled' ? namaste.value : undefined;
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
    if (layoutRead.status === 'rejected') {
      throw layoutRead.reason;
    }
    const layout = layoutRead.value;
    const layoutName = layout === undefined ? undefined : declaredLayoutName(layoutPath, layout);
    let layoutConfig: OcflExtensionConfig | undefined;
    let configPath: string | undefined;
    if (layoutName !== undefined) {
      supportedLayoutClass(layoutName);
      configPath = path.join(this.root, EXTENSIONS_DIR, layoutName, EXTENSION_CONFIG);
      const content = await readIfExists(configPath);
      if (content !== undefined) {
        layoutConfig = parseLayoutConfig(configPath, content);
      }
    }
    try {
      this.#layout = this.#resolveLayout(layoutName, layoutConfig);
    } catch (error) {
      // the configured layout was checked when the storage was constructed, so the root's config.json is at fault
      if (layoutConfig && error instanceof OcflError && error.code === 'INVALID_LAYOUT_CONFIG') {
        throw new OcflError('INVALID_LAYOUT_CONFIG', `The layout config ${configPath} is invalid: ${error.message}`);
      }
      throw error;
    }

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
    // create namaste
    const prefix = NAMASTE_PREFIX_STORAGE;
    const filenamePrefix = NAMASTE_T + prefix;
    const filePath = path.join(this.root, filenamePrefix + this.ocflVersion);
    await store.writeFile(filePath, `${prefix + this.ocflVersion}\n`);

    // create layout
    if (!this.#layout) {
      this.#layout = new DEFAULT_LAYOUT();
    }
    const layout = { extension: this.#layout.name, description: this.#layout.description };
    await store.writeFile(path.join(this.root, OCFL_LAYOUT), JSON.stringify(layout, null, 2));
    if (this.#layout.config) {
      await store.writeFile(path.join(this.root, EXTENSIONS_DIR, this.#layout.name, EXTENSION_CONFIG), JSON.stringify(this.#layout.config, null, 2));
    }

    if (specText) {
      await store.writeFile(path.join(this.root, specText.file), specText.content);
    }
    return this;
  }

  /**
   * Delete an object and any parent directories it leaves empty, up to but not including the storage root.
   * Not guarded against a concurrent update of the object.
   * @param id - Identifier of the object
   * @throws {@link ObjectNotFoundError} If the object does not exist.
   * @throws {@link OcflError} `NOT_AN_OBJECT` if the path holds something with no OCFL object declaration; nothing is deleted.
   */
  async remove(id: string): Promise<void> {
    const object = this.object(id);
    const objectRoot = object.root;
    const relative = path.relative(this.root, objectRoot);
    const [firstSegment] = relative.split(path.sep);
    if (!relative || firstSegment === '..' || firstSegment === EXTENSIONS_DIR) {
      throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `The object id <${id}> maps to "${objectRoot}", which can't hold an object in this storage root.`);
    }
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
    // A layout can map several ids to one path, such as an id with a `..` segment
    const inventory = await object.getInventory();
    if (inventory?.id !== id) {
      throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `"${objectRoot}" holds the object <${inventory?.id}>, not <${id}>, so nothing was deleted.`);
    }
    await fs.promises.rm(objectRoot, { recursive: true, force: true });
    try {
      for (let dir = path.dirname(objectRoot); dir !== this.root; dir = path.dirname(dir)) {
        await store.removeIfEmpty(dir);
      }
    } catch (_error) {
      // The object is gone, so a retry would throw ObjectNotFoundError; a leftover empty directory is harmless
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
      if (!dirent.isDirectory()) {
        continue;
      }
      const basePath = path.join(dirPath, dirent.name);
      const nv = await findNamasteVersion(NAMASTE_PREFIX_OBJECT, basePath);
      if (nv) {
        yield new OcflObject({
          root: basePath,
          workspace: this.#workspace ? path.join(this.#workspace, path.relative(this.root, basePath)) : undefined,
          ocflVersion: nv,
          ...this.#objectConfig,
        });
      } else {
        yield* this.#objectsUnder(basePath);
      }
    }
  }
}

export { OcflStorage };
