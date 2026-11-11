import fs from 'node:fs';
import nodePath from 'node:path';
import { inspect } from 'node:util';
import { OcflConstants } from './constants.ts';
import { OcflError } from './error.ts';
import type { BuiltInLayout, OcflExtensionConfig } from './extension.ts';
import { createLayout, type LayoutClass, supportedLayoutClass } from './extensions/index.ts';
import * as store from './store.ts';
import type { Layout, LayoutConfig, OcflVersion } from './types.ts';
import { deepFreeze, findNamasteVersion, isDirEmpty, parseJsonObject, readIfExists } from './utils.ts';
import { createError, ValidationError } from './validation.ts';

const { OCFL_VERSION, OCFL_LAYOUT, EXTENSIONS_DIR, EXTENSION_CONFIG, WORKSPACE_EXTENSION, NAMASTE_PREFIX_STORAGE, NAMASTE_T } = OcflConstants;

/** A local storage root extension, documented in the root as the OCFL spec (§4.5) allows */
const WORKSPACE_EXTENSION_TEXT = `# ${WORKSPACE_EXTENSION}

A local storage root extension used by the ocfl-js library (@ocfl/ocfl-fs).

While an object is being updated, its new version is assembled in
\`${EXTENSIONS_DIR}/${WORKSPACE_EXTENSION}/<object path>/<version>\` and then moved into the object root.
The directory exists only while an update is in progress. Anything left in it afterwards is
from an update that was interrupted, and is not part of any OCFL object.
`;

const SPEC_TEXT_FILES: Record<OcflVersion, string> = { '1.0': 'ocfl_1.0.txt', '1.1': 'ocfl_1.1.md' };

type SpecText = { file: string; content: Buffer };

async function readSpecText(ocflVersion: OcflVersion): Promise<SpecText> {
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

/** @throws {@link OcflError} `INVALID_LAYOUT_CONFIG`, naming `file`, if the layout rejects `config` */
function layoutFromConfigFile(layoutClass: LayoutClass, config: OcflExtensionConfig | undefined, file: string): BuiltInLayout {
  try {
    return new layoutClass(config);
  } catch (error) {
    if (error instanceof OcflError && error.code === 'INVALID_LAYOUT_CONFIG') {
      throw new OcflError('INVALID_LAYOUT_CONFIG', `The layout config ${file} is invalid: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Read the OCFL version and layout a storage root declares. The layout is `undefined` if it has no `ocfl_layout.json`.
 * @throws `ValidationError` `E069` if the storage root has no declaration, `E080` if its declaration is invalid.
 * @throws `ValidationError` `E070` if `ocfl_layout.json` has no string `extension`.
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if `ocfl_layout.json` names a layout this library doesn't implement.
 * @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if the layout's `config.json` isn't a JSON object or has parameters the layout rejects.
 * @throws The file system error if the storage root declaration, `ocfl_layout.json` or the layout's `config.json` exists but can't be read.
 */
async function readStorageRoot(root: string): Promise<{ ocflVersion: OcflVersion; layout: BuiltInLayout | undefined }> {
  const layoutPath = nodePath.join(root, OCFL_LAYOUT);
  const [namaste, layoutRead] = await Promise.allSettled([findNamasteVersion(NAMASTE_PREFIX_STORAGE, root), readIfExists(layoutPath)]);
  if (namaste.status === 'rejected') {
    throw namaste.reason;
  }
  const ocflVersion = namaste.value;
  if (ocflVersion === '') {
    throw createError('E080', root);
  }
  if (!ocflVersion) {
    throw createError('E069', root);
  }
  if (layoutRead.status === 'rejected') {
    throw layoutRead.reason;
  }
  if (layoutRead.value === undefined) {
    return { ocflVersion, layout: undefined };
  }
  const declaredName = declaredLayoutName(layoutPath, layoutRead.value);
  // Checked before the config is read: a declared name that is a path must not reach outside the root
  const layoutClass = supportedLayoutClass(declaredName);
  const configPath = nodePath.join(root, EXTENSIONS_DIR, declaredName, EXTENSION_CONFIG);
  const content = await readIfExists(configPath);
  const config = content === undefined ? undefined : parseLayoutConfig(configPath, content);
  if (config?.extensionName !== undefined && config.extensionName !== declaredName) {
    throw new OcflError(
      'INVALID_LAYOUT_CONFIG',
      `The layout config ${configPath} is for ${inspect(config.extensionName)}, not the layout "${declaredName}" that ${OCFL_LAYOUT} declares.`,
    );
  }
  return { ocflVersion, layout: layoutFromConfigFile(layoutClass, config, configPath) };
}

/** Write the files that make the empty directory `root` a storage root */
async function writeStorageRoot(root: string, ocflVersion: OcflVersion, layout: BuiltInLayout, specText?: SpecText): Promise<void> {
  if (specText) {
    await store.writeFile(nodePath.join(root, specText.file), specText.content);
  }
  await store.writeFile(nodePath.join(root, `${WORKSPACE_EXTENSION}.md`), WORKSPACE_EXTENSION_TEXT);
  if (layout.documentation) {
    await store.writeFile(nodePath.join(root, `${layout.name}.md`), layout.documentation);
  }
  if (layout.config) {
    await store.writeFile(nodePath.join(root, EXTENSIONS_DIR, layout.name, EXTENSION_CONFIG), JSON.stringify(layout.config, null, 2));
  }
  await store.writeFile(nodePath.join(root, OCFL_LAYOUT), JSON.stringify({ extension: layout.name, description: layout.description }, null, 2));
  // Last, so that a root left half-written can't be opened, least of all with the default parameters of its layout
  const declaration = NAMASTE_PREFIX_STORAGE + ocflVersion;
  await store.writeFile(nodePath.join(root, NAMASTE_T + declaration), `${declaration}\n`);
}

/** The base directory holding OCFL objects. */
interface StorageRoot {
  /** Absolute path of the storage root. */
  readonly path: string;
  /** OCFL version of the storage root, and of objects created in it. */
  readonly ocflVersion: '1.0' | '1.1';
  /** The storage root's layout, with every parameter present. */
  readonly layout: Layout;
}

function storageRoot(root: string, ocflVersion: OcflVersion, layout: BuiltInLayout): StorageRoot {
  return deepFreeze({ path: root, ocflVersion, layout: { extensionName: layout.name, ...layout.parameters } as Layout });
}

function absolutePath(rootPath: string): string {
  if (typeof rootPath !== 'string' || rootPath === '') {
    throw new TypeError('The path of the storage root is required.');
  }
  return nodePath.resolve(rootPath);
}

/** @throws `TypeError` if `layout` isn't `{ extensionName, ...parameters }` for a layout this library implements, with parameters it accepts */
function chosenLayout(layout: LayoutConfig): BuiltInLayout {
  if (typeof layout !== 'object' || layout === null) {
    throw new TypeError('A layout must be a config object with an extensionName.');
  }
  try {
    // A copy, so the layout can't change under the caller's hands after it has been checked
    const config = structuredClone(layout);
    const created = createLayout(config);
    const unknown = Object.keys(config).filter((name) => name !== 'extensionName' && !Object.hasOwn(created.parameters, name));
    if (unknown.length > 0) {
      throw new TypeError(`Layout ${created.name} has no parameter ${unknown.map((name) => inspect(name)).join(' or ')}.`);
    }
    return created;
  } catch (error) {
    if (error instanceof OcflError && (error.code === 'UNSUPPORTED_LAYOUT' || error.code === 'INVALID_LAYOUT_CONFIG')) {
      throw new TypeError(error.message, { cause: error });
    }
    if (error instanceof DOMException && error.name === 'DataCloneError') {
      throw new TypeError('A layout must hold only strings, numbers, booleans and arrays of them.', { cause: error });
    }
    throw error;
  }
}

/**
 * Creates a new OCFL 1.1 storage root in an empty or missing directory.
 *
 * @throws {@link OcflError} `DIRECTORY_NOT_EMPTY` if `path` holds anything.
 * @throws `TypeError` if the layout or one of its parameters is invalid.
 * @example
 * ```ts
 * const root = await createStorageRoot('/srv/ocfl', {
 *   layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
 * });
 * ```
 */
async function createStorageRoot(path: string, options: { layout: LayoutConfig }): Promise<StorageRoot> {
  const root = absolutePath(path);
  const layout = chosenLayout(options?.layout);
  await fs.promises.mkdir(root, { recursive: true });
  if (!(await isDirEmpty(root))) {
    throw new OcflError('DIRECTORY_NOT_EMPTY', `Cannot create a storage root in ${root}, which is not empty.`);
  }
  // Read before the first write: a failed create can't be retried once the root is non-empty
  const specText = await readSpecText(OCFL_VERSION);
  await writeStorageRoot(root, OCFL_VERSION, layout, specText);
  return storageRoot(root, OCFL_VERSION, layout);
}

/**
 * Opens an existing storage root. Its layout is read from its own `ocfl_layout.json`.
 *
 * @throws {@link OcflError} `INVALID_STORAGE_ROOT` if `path` is not a storage root, or has no `ocfl_layout.json`.
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if it declares a layout this library doesn't implement.
 * @example
 * ```ts
 * const root = await openStorageRoot('/srv/ocfl');
 * ```
 */
async function openStorageRoot(path: string): Promise<StorageRoot> {
  const root = absolutePath(path);
  try {
    const { ocflVersion, layout } = await readStorageRoot(root);
    if (!layout) {
      throw new OcflError('INVALID_STORAGE_ROOT', `The storage root ${root} has no ${OCFL_LAYOUT}, so the layout of its objects is unknown.`);
    }
    return storageRoot(root, ocflVersion, layout);
  } catch (error) {
    if (error instanceof ValidationError || (error instanceof OcflError && error.code === 'INVALID_LAYOUT_CONFIG')) {
      throw new OcflError('INVALID_STORAGE_ROOT', error.message, { ocflCode: error.ocflCode, cause: error });
    }
    throw error;
  }
}

export { createStorageRoot, openStorageRoot, readSpecText, readStorageRoot, type StorageRoot, writeStorageRoot };
