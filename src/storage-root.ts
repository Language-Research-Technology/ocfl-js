import fs from 'node:fs';
import nodePath from 'node:path';
import { inspect } from 'node:util';
import { OcflConstants } from './constants.ts';
import { checkedDetails, type Draft, type VersionDetails } from './draft.ts';
import { type OcflError, ocflError } from './error.ts';
import type { BuiltInLayout } from './extension.ts';
import { builtInLayoutClass, createLayout } from './extensions/index.ts';
import { listObjects } from './list.ts';
import { LOCK_NAME, NO_OBJECT_ROOT, REMOVING } from './lock.ts';
import { createObject, type OcflObject, openObject } from './ocfl-object.ts';
import { recoverObject } from './recover.ts';
import { removeObject } from './remove.ts';
import * as store from './store.ts';
import type { Layout, LayoutConfig, OcflVersion } from './types.ts';
import { deepFreeze, findNamasteVersion, isDirEmpty, isNonEmptyString, parseJsonObject, readIfExists, relativeWithin } from './utils.ts';
import { createError } from './validation.ts';

const { OCFL_VERSION, OCFL_LAYOUT, EXTENSIONS_DIR, EXTENSION_CONFIG, WORKSPACE_EXTENSION, NAMASTE_PREFIX_STORAGE, NAMASTE_T } = OcflConstants;

/** A local storage root extension, documented in the root as the OCFL spec (§4.5) allows */
const WORKSPACE_EXTENSION_TEXT = `# ${WORKSPACE_EXTENSION}

A local storage root extension used by the ocfl-js library (@ocfl/ocfl-fs).

Each object has one directory here, \`${EXTENSIONS_DIR}/${WORKSPACE_EXTENSION}/<object path>/\`, where
\`<object path>\` is the object root relative to the storage root. While the object is being created,
updated or removed, that directory holds:

- \`${LOCK_NAME}\`: the object's lock, a file whose first line is the time it was taken (ISO 8601, UTC). A
  second line, \`${NO_OBJECT_ROOT}\`, means the object root did not exist when the lock was taken. A
  second line, \`${REMOVING}\`, means the object is being removed. Only the writer that created the
  lock may change the object. The library never waits for a lock, and never removes one because of
  its age.
- \`<version>/\`: the new version being assembled, which is then moved into the object root.

The directories exist only while a create, update or remove is in progress. Anything left in them
afterwards is from one that was interrupted, and is not part of any OCFL object. A lock or a
version left behind keeps the object from being updated or removed, until the library's
\`recover\` is called for the object.
`;

const SPEC_TEXT_FILE = 'ocfl_1.1.md';

/** @throws {@link OcflError} `INVALID_STORAGE_ROOT` (`E070`) if `content` has no string `extension` */
function declaredLayoutName(file: string, content: string): string {
  const extension = parseJsonObject(content)?.extension;
  if (typeof extension !== 'string') {
    throw createError('E070', file, 'it has no string extension');
  }
  return extension;
}

/**
 * Read the OCFL version and layout a storage root declares.
 * @throws {@link OcflError} `INVALID_STORAGE_ROOT` if the storage root has no declaration (`E069`) or an invalid one (`E080`), has no `ocfl_layout.json` or one
 * with no string `extension` (`E070`), or its layout's `config.json` isn't a JSON object, is for another layout or has parameters the layout rejects.
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if `ocfl_layout.json` names a layout this library doesn't implement.
 * @throws The file system error if the storage root declaration, `ocfl_layout.json` or the layout's `config.json` exists but can't be read.
 */
async function readStorageRoot(root: string): Promise<{ ocflVersion: OcflVersion; layout: BuiltInLayout }> {
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
    throw ocflError('INVALID_STORAGE_ROOT', `The storage root ${root} has no ${OCFL_LAYOUT}, so the layout of its objects is unknown.`);
  }
  const declaredName = declaredLayoutName(layoutPath, layoutRead.value);
  // Checked before the config is read: a declared name that is a path must not reach outside the root
  const layoutClass = builtInLayoutClass(declaredName);
  if (!layoutClass) {
    throw ocflError('UNSUPPORTED_LAYOUT', `Layout "${declaredName}", which the storage root ${root} declares, is not supported.`);
  }
  const configPath = nodePath.join(root, EXTENSIONS_DIR, declaredName, EXTENSION_CONFIG);
  const content = await readIfExists(configPath);
  const config = content === undefined ? undefined : parseJsonObject(content);
  if (content !== undefined && !config) {
    throw ocflError('INVALID_STORAGE_ROOT', `The layout config ${configPath} is not a JSON object.`);
  }
  if (config?.extensionName !== undefined && config.extensionName !== declaredName) {
    throw ocflError(
      'INVALID_STORAGE_ROOT',
      `The layout config ${configPath} is for ${inspect(config.extensionName)}, not the layout "${declaredName}" that ${OCFL_LAYOUT} declares.`,
    );
  }
  try {
    // Not createLayout: a parameter the layout doesn't have is ignored in a root another tool may have written
    return { ocflVersion, layout: new layoutClass(config) };
  } catch (error) {
    if (error instanceof TypeError) {
      throw ocflError('INVALID_STORAGE_ROOT', `The layout config ${configPath} is invalid: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/** Write the files that make the empty directory `root` an OCFL 1.1 storage root */
async function writeStorageRoot(root: string, layout: BuiltInLayout, specText: Buffer): Promise<void> {
  await store.writeFile(nodePath.join(root, SPEC_TEXT_FILE), specText);
  await store.writeFile(nodePath.join(root, `${WORKSPACE_EXTENSION}.md`), WORKSPACE_EXTENSION_TEXT);
  if (layout.documentation) {
    await store.writeFile(nodePath.join(root, `${layout.name}.md`), layout.documentation);
  }
  if (layout.config) {
    await store.writeFile(nodePath.join(root, EXTENSIONS_DIR, layout.name, EXTENSION_CONFIG), JSON.stringify(layout.config, null, 2));
  }
  await store.writeFile(nodePath.join(root, OCFL_LAYOUT), JSON.stringify({ extension: layout.name, description: layout.description }, null, 2));
  // Last, so that a root left half-written can't be opened, least of all with the default parameters of its layout
  const declaration = NAMASTE_PREFIX_STORAGE + OCFL_VERSION;
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

  /**
   * Reads an object's inventory and returns the object as it is now. It does not change when later versions are committed.
   *
   * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object with this id, or another writer is creating it and hasn't committed it.
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's inventory is missing, corrupt or inconsistent, or the object has no declaration.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id to a directory, or that directory holds another object.
   * @example
   * ```ts
   * const object = await root.open('arcp://name,corpus/item/1');
   * const file = object.head.files.get('ro-crate-metadata.json');
   * const metadata = JSON.parse(await file!.text());
   * ```
   */
  open(id: string): Promise<OcflObject>;

  /**
   * Creates an object with the draft built by `build` as its first version. If `build` throws, nothing is created.
   * The object uses sha512 digests and the `content` directory, at the storage root's OCFL version.
   *
   * @throws {@link OcflError} `OBJECT_EXISTS` if an object with this id already exists.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id to a directory, or that directory holds something else, is below a file, or is inside another object.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if another writer is creating the same object, or died creating it; `lockedAt` says since when, and is absent if the lock couldn't be read or was released meanwhile.
   * @throws {@link OcflError} `CROSS_FILESYSTEM_MOVE` if the workspace is on a different file system from the object.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if the create failed after its root inventory was put in place, failed putting it in place in a way that may have done so, or failed earlier and what it made couldn't all be removed; `cause` is the failure. The object may have been created, and stays locked. Also thrown, before `build` runs and leaving the object unlocked, if an earlier create left an unfinished version in the workspace. Don't simply repeat the create: call {@link StorageRoot.recover}, then open the object to see whether it was created.
   * @throws `TypeError` if the id, the message or the user's name is missing or empty.
   * @throws Whatever `build` or a draft operation throws; nothing of the object is left, and it isn't locked.
   * @example
   * ```ts
   * const object = await root.create(id, { message: 'Initial deposit', user: { name: 'Alice' } }, async (draft) => {
   *   await draft.write('ro-crate-metadata.json', JSON.stringify(metadata));
   * });
   * ```
   */
  create(id: string, details: VersionDetails, build: (draft: Draft) => Promise<void>): Promise<OcflObject>;

  /**
   * Lists every object in the storage root, in no particular order. Each object is read when the listing reaches it.
   * An object that can't be opened is yielded as an `INVALID_OBJECT` error whose message names its directory, and the listing carries on.
   * A directory with an invalid object declaration is one of these: it isn't searched for objects.
   *
   * An object that another writer is creating and hasn't committed is left out, and so is the `extensions` directory.
   * Leaving the loop early closes every directory the listing opened.
   *
   * @throws The file system error that stopped the listing.
   * @example
   * ```ts
   * for await (const object of root.objects()) {
   *   if (object instanceof OcflError) {
   *     console.warn(object.message);
   *     continue;
   *   }
   *   await index(object.id, object.head.files);
   * }
   * ```
   */
  objects(): AsyncIterable<OcflObject | OcflError>;

  /**
   * Deletes an object and all its versions, and the parent directories that leaves empty. The object's lock is held while it is deleted.
   *
   * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object with this id.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if the object is being updated or created, or a writer died doing so; `lockedAt` says since when. Nothing is deleted. After a dead writer, call {@link StorageRoot.recover} and then `remove` again.
   * @throws {@link OcflError} `INVALID_OBJECT` if the id's directory holds something that isn't an object, or an object whose inventory is missing, corrupt or inconsistent, so its id can't be confirmed; nothing is deleted.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id to a directory, or that directory holds a different object; nothing is deleted.
   * @throws `TypeError` if the id is missing or empty.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if deleting the object failed part of the way through, or it was deleted and its lock couldn't be released; `cause` is the failure. The object stays locked, and may be partly deleted: call {@link StorageRoot.recover}, which finishes removing it.
   * @example
   * ```ts
   * await root.remove('arcp://name,corpus/item/1');
   * ```
   */
  remove(id: string): Promise<void>;

  /**
   * Clears what a dead update or create left behind and releases the object's lock. Does nothing if there is nothing to clear.
   *
   * **Only call this when no writer of the object is alive: a live writer's update is destroyed**, and the library can't tell
   * a live writer from a dead one. `lockedAt` on `UPDATE_IN_PROGRESS` says when the lock was taken.
   *
   * A remove that had begun deleting the object is finished. An update that wasn't committed is discarded: the unfinished version in the workspace, the directory of the version after the head
   * in the object, and staged inventory files are removed. A create that wasn't committed is discarded while its lock is still there:
   * the declaration and first version of an object that never got an inventory, and its directory if the create made it. An update that
   * was committed is completed by writing the root inventory's sidecar. A version is never made the head by `recover`, and no other
   * version directory is ever removed.
   *
   * After `RECOVERY_NEEDED`, call `recover` and then open the object again before retrying: the head shows whether the update was committed.
   *
   * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object with this id and nothing left over for it.
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's inventory is corrupt or inconsistent, or the object is inside another object; or if it has a declaration and no inventory, and either no lock or a version other than the first, which a dead create never leaves. Nothing is changed.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id to a directory, or that directory holds another object, or holds no object and is inside one; nothing is changed.
   * @throws `TypeError` if the id is missing or empty.
   * @throws The file system error that stopped it; the object stays locked, and `recover` can be called again.
   * @example
   * ```ts
   * try {
   *   object = await object.update(details, change);
   * } catch (error) {
   *   if ((error as OcflError).code !== 'RECOVERY_NEEDED') throw error;
   *   // This process is the only writer, so none is alive
   *   await root.recover(id);
   *   object = await root.open(id);
   * }
   * ```
   */
  recover(id: string): Promise<void>;
}

/**
 * @returns The object root of `id`, relative to the storage root
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id, or maps it to the storage root, outside it, or into its extensions directory
 */
function mappedObjectPath(root: string, layout: BuiltInLayout, id: string): string {
  const mapped = layout.map(id);
  const relative = relativeWithin(root, nodePath.join(root, mapped));
  // Case-insensitive, so a case-insensitive filesystem can't map an object root into extensions/
  if (!relative || relative.split(nodePath.sep)[0]?.toLowerCase() === EXTENSIONS_DIR) {
    throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `The object id <${id}> maps to "${mapped}", which can't hold an object in this storage root.`);
  }
  return relative;
}

function checkedId(id: string): string {
  if (!isNonEmptyString(id)) {
    throw new TypeError('The id of the object is required.');
  }
  return id;
}

function storageRoot(root: string, ocflVersion: OcflVersion, layout: BuiltInLayout): StorageRoot {
  const objectRootOf = (id: string) => nodePath.join(root, mappedObjectPath(root, layout, id));
  return deepFreeze({
    path: root,
    ocflVersion,
    layout: { extensionName: layout.name, ...layout.parameters } as Layout,
    async open(id: string) {
      return openObject(root, objectRootOf(checkedId(id)), id);
    },
    async create(id: string, details: VersionDetails, build: (draft: Draft) => Promise<void>) {
      const objectId = checkedId(id);
      const checked = checkedDetails(details);
      return createObject(root, objectRootOf(objectId), objectId, ocflVersion, checked, build);
    },
    objects() {
      return listObjects(root);
    },
    async remove(id: string) {
      await removeObject(root, objectRootOf(checkedId(id)), id);
    },
    async recover(id: string) {
      await recoverObject(root, objectRootOf(checkedId(id)), id);
    },
  });
}

function absolutePath(rootPath: string): string {
  if (!isNonEmptyString(rootPath)) {
    throw new TypeError('The path of the storage root is required.');
  }
  return nodePath.resolve(rootPath);
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
  const layout = createLayout(options?.layout);
  await fs.promises.mkdir(root, { recursive: true });
  if (!(await isDirEmpty(root))) {
    throw ocflError('DIRECTORY_NOT_EMPTY', `Cannot create a storage root in ${root}, which is not empty.`);
  }
  // Read before the first write: a failed create can't be retried once the root is non-empty
  const specText = await fs.promises.readFile(new URL(`../resources/${SPEC_TEXT_FILE}`, import.meta.url));
  await writeStorageRoot(root, layout, specText);
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
  const { ocflVersion, layout } = await readStorageRoot(root);
  return storageRoot(root, ocflVersion, layout);
}

export { createStorageRoot, openStorageRoot, type StorageRoot };
