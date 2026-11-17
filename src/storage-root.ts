import fs from 'node:fs';
import nodePath from 'node:path';
import { inspect } from 'node:util';
import { findNamasteVersion, OcflConstants, type OcflSpecVersion, SEVERAL_DECLARATIONS } from './constants.ts';
import { type CreateOptions, type Draft, writeOptions } from './draft.ts';
import { OcflError, ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { BuiltInLayout } from './layouts/built-in-layout.ts';
import { builtInLayoutClass, createLayout, IMPLEMENTED_LAYOUTS, type Layout, type LayoutConfig } from './layouts/index.ts';
import { type ListedObject, listObjects } from './list.ts';
import { LOCK_NAME } from './lock.ts';
import { objectNotFound, objectState } from './object-on-disk.ts';
import { createObject, type OcflObject, openObject } from './ocfl-object.ts';
import { createError } from './ocfl-rules.ts';
import { removeObject } from './remove.ts';
import { SPEC_TEXT } from './spec-text.ts';
import { findUnfinishedWrite, listUnfinishedWrites, type UnfinishedWrite } from './unfinished-write.ts';
import { deepFreeze, isNonEmptyString, optionsObject, parseJsonObject } from './utils.ts';
import { longestWriterPath } from './workspace.ts';

const { OCFL_VERSION, OCFL_LAYOUT, EXTENSIONS_DIR, EXTENSION_CONFIG, WORKSPACE_EXTENSION, NAMASTE_PREFIX_STORAGE, NAMASTE_T } = OcflConstants;

/** A local storage root extension, documented in the root as the OCFL spec (§4.5) allows */
const WORKSPACE_EXTENSION_TEXT = `# ${WORKSPACE_EXTENSION}

A local storage root extension used by the ocfl-js library (@ocfl/ocfl-fs).

Each object has one directory here, \`${EXTENSIONS_DIR}/${WORKSPACE_EXTENSION}/<object path>/\`, where
\`<object path>\` is the object root relative to the storage root. While the object is being created,
updated or removed, that directory holds:

- \`${LOCK_NAME}\`: the object's lock, a JSON object. \`id\` is the id of the object, \`operation\` what
  its writer is doing (\`create\`, \`update\` or \`remove\`), \`lockedAt\` the time the lock was taken
  (ISO 8601, UTC), and \`objectRootExisted\` whether the object root existed then. \`removing\`, if
  \`true\`, means a remove has begun deleting the object root. Only the writer that created the lock
  may change the object. The library never waits for a lock, and never removes one because of its
  age. A lock is written whole to a file beside it whose name starts \`.lock-\`, then put in place.
- \`<version>/\`: the new version being assembled, which is then moved into the object root.

The directories exist only while a create, update or remove is in progress. Anything left in them
afterwards is from one that was interrupted, and is not part of any OCFL object. A lock left
behind keeps the object from being updated or removed, until the library recovers the object's
unfinished write.
`;

const SPEC_TEXT_FILE = 'ocfl_1.1.md';

const ISSUES_URL = 'https://github.com/Language-Research-Technology/ocfl-js/issues';

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
 * @throws {@link OcflError} `STORAGE_ROOT_NOT_FOUND` if `root` is missing, with no file above it, or is an empty directory.
 * @throws {@link OcflError} `INVALID_STORAGE_ROOT` if `root` is a file, is below one, or is a directory with something in it, and has no declaration (`E069`); or it has more than one (`E076`) or an invalid one (`E080`), has an `ocfl_layout.json`
 * with no string `extension` (`E070`), or its layout's `config.json` isn't a JSON object, is for another layout or has parameters the layout rejects.
 * @throws {@link OcflError} `LAYOUT_NOT_DECLARED` if `root` has a valid declaration but no `ocfl_layout.json`.
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if `ocfl_layout.json` names a layout this library doesn't implement.
 * @throws The file system error if `root` has no declaration and can't be read, or the storage root declaration, `ocfl_layout.json` or the layout's `config.json` exists but can't be read.
 */
async function readStorageRoot(root: string): Promise<{ ocflVersion: OcflSpecVersion; layout: BuiltInLayout }> {
  const layoutPath = nodePath.join(root, OCFL_LAYOUT);
  const [namaste, layoutRead] = await Promise.allSettled([findNamasteVersion(NAMASTE_PREFIX_STORAGE, root), fileSystem.readIfExists(layoutPath)]);
  if (namaste.status === 'rejected') {
    throw namaste.reason;
  }
  const ocflVersion = namaste.value;
  if (ocflVersion === SEVERAL_DECLARATIONS) {
    throw createError('E076', root);
  }
  if (ocflVersion === '') {
    throw createError('E080', root);
  }
  if (!ocflVersion) {
    if ((await fileSystem.dirContents(root)) === 'empty') {
      throw ocflError('STORAGE_ROOT_NOT_FOUND', `There is no storage root at ${root}. Create one with createStorageRoot.`);
    }
    throw createError('E069', root);
  }
  if (layoutRead.status === 'rejected') {
    throw layoutRead.reason;
  }
  if (layoutRead.value === undefined) {
    throw ocflError(
      'LAYOUT_NOT_DECLARED',
      `The storage root ${root} has no ${OCFL_LAYOUT}, so the layout of its objects is unknown. ` +
        `Add an ${OCFL_LAYOUT} naming its storage layout, such as {"extension": "0004-hashed-n-tuple-storage-layout"}; this library implements ${IMPLEMENTED_LAYOUTS}.`,
    );
  }
  const declaredName = declaredLayoutName(layoutPath, layoutRead.value);
  // Checked before the config is read: a declared name that is a path must not reach outside the root
  const layoutClass = builtInLayoutClass(declaredName);
  if (!layoutClass) {
    throw ocflError(
      'UNSUPPORTED_LAYOUT',
      `The storage root ${root} declares the storage layout "${declaredName}", which this library doesn't implement; it implements ${IMPLEMENTED_LAYOUTS}. ` +
        `To open this storage root, ask for "${declaredName}" to be added to the library at ${ISSUES_URL}.`,
    );
  }
  const configPath = nodePath.join(root, EXTENSIONS_DIR, declaredName, EXTENSION_CONFIG);
  const content = await fileSystem.readIfExists(configPath);
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
    // Layout constructors throw only TypeError; anything else is a bug, not a bad config
    /* node:coverage ignore next */
    throw error;
  }
}

/** Write the files that make the empty directory `root` an OCFL 1.1 storage root */
async function writeStorageRoot(root: string, layout: BuiltInLayout, flusher: fileSystem.Flusher): Promise<void> {
  await fileSystem.writeFile(nodePath.join(root, SPEC_TEXT_FILE), SPEC_TEXT);
  await fileSystem.writeFile(nodePath.join(root, `${WORKSPACE_EXTENSION}.md`), WORKSPACE_EXTENSION_TEXT);
  if (layout.documentation) {
    await fileSystem.writeFile(nodePath.join(root, `${layout.name}.md`), layout.documentation);
  }
  if (layout.config) {
    await fileSystem.writeFile(nodePath.join(root, EXTENSIONS_DIR, layout.name, EXTENSION_CONFIG), JSON.stringify(layout.config, null, 2));
  }
  await fileSystem.writeFile(nodePath.join(root, OCFL_LAYOUT), JSON.stringify({ extension: layout.name, description: layout.description }, null, 2));
  await flusher.flushTree(root);
  // Last, so that a root left half-written can't be opened, least of all with the default parameters of its layout
  const declaration = NAMASTE_PREFIX_STORAGE + OCFL_VERSION;
  const declarationFile = nodePath.join(root, NAMASTE_T + declaration);
  await fileSystem.writeFile(declarationFile, `${declaration}\n`);
  await flusher.flush(declarationFile, root);
}

/**
 * Whether a create or update through a storage root flushes what it writes to disk before it resolves.
 *
 * - `'full'`: every file and directory of the new version is flushed, so once `create()` or `update()` resolves the version survives a
 *   crash or power failure. Recovering an unfinished write flushes the files it writes too, and so does creating a storage root.
 * - `'none'`: nothing is flushed but the object's lock, so that bulk loading isn't slowed by a flush per file. After a crash or power
 *   failure an object written lately can be left with empty or short files, and nothing reports it until a fixity check. Run the system
 *   `sync` command after the batch, and keep the source files until it returns.
 */
type Durability = 'full' | 'none';

const FLUSHERS: Readonly<Record<Durability, fileSystem.Flusher>> = { full: fileSystem.FLUSHING, none: fileSystem.NOT_FLUSHING };

/** What an object takes from the storage root it is opened or created through */
interface RootSettings {
  /** The storage root's OCFL version */
  readonly ocflVersion: OcflSpecVersion;
  readonly flusher: fileSystem.Flusher;
}

/** Options for {@link openStorageRoot}. */
interface OpenStorageRootOptions {
  /** Whether creates and updates through the storage root flush what they write to disk before they resolve. Defaults to `'full'`. */
  readonly durability?: Durability | undefined;
}

/** Options for {@link createStorageRoot}. */
interface CreateStorageRootOptions extends OpenStorageRootOptions {
  /** The storage layout that maps an object id to the directory of its object. */
  readonly layout: LayoutConfig;
}

/**
 * @returns What flushes as `durability` says, `'full'` if it is `undefined`
 * @throws `TypeError` if it is neither durability
 */
function checkedFlusher(durability: unknown = 'full'): fileSystem.Flusher {
  if (typeof durability !== 'string' || !Object.hasOwn(FLUSHERS, durability)) {
    throw new TypeError(`The durability must be 'full' or 'none', not ${inspect(durability)}.`);
  }
  return FLUSHERS[durability as Durability];
}

/** The base directory holding OCFL objects. */
interface StorageRoot {
  /** Absolute path of the storage root. */
  readonly path: string;
  /** OCFL version of the storage root, and of objects created in it. */
  readonly ocflVersion: OcflSpecVersion;
  /** The storage root's layout, with every parameter present. */
  readonly layout: Layout;

  /**
   * Reads an object's inventory and returns the object as it is now. It does not change when later versions are committed.
   *
   * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object with this id, another writer is creating it and hasn't committed it, or the layout can't map the id to a directory the file system can hold, so no object can have it; then `cause` is the layout's `ID_INCOMPATIBLE_WITH_LAYOUT`.
   * @throws {@link OcflError} `INVALID_OBJECT` if the object's inventory is missing, corrupt or inconsistent, the object has no declaration or an invalid one, its OCFL version is later than the storage root's (E081), or it is inside another object (E082).
   * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if that directory holds an object with another id, or holds files that aren't an object, is a file or is below one.
   * @throws `TypeError` if the id is missing or empty.
   * @throws The file system error if a file or directory the object is read from, or checked against, exists but can't be read.
   * @example
   * ```ts
   * const object = await root.open('arcp://name,corpus/item/1');
   * const file = object.head.files.get('ro-crate-metadata.json');
   * const metadata = JSON.parse(await file!.text());
   * ```
   */
  open(id: string): Promise<OcflObject>;

  /**
   * Whether there is an object with this id: `true` exactly when {@link StorageRoot.create} would throw `OBJECT_EXISTS`, unless the object's lock in the workspace would be too long for the file system.
   * A create that another writer hasn't committed gives `false`, and so does an id the layout can't map to a directory the file system can hold. The inventory isn't read or checked, so a damaged object gives `true`, and {@link StorageRoot.open} then reports the damage.
   *
   * Another writer can create the object between `has()` and a `create()`; to create an object only if it is absent, catch `OBJECT_EXISTS` from `create()` instead.
   *
   * @throws `TypeError` if the id is missing or empty.
   * @throws The file system error if the object's directory, inventory or lock can't be checked.
   * @example
   * ```ts
   * console.log(`${id}: ${(await root.has(id)) ? 'in the archive' : 'not deposited yet'}`);
   * ```
   */
  has(id: string): Promise<boolean>;

  /**
   * Creates an object with the draft built by `build` as its first version. If `build` throws, nothing is created.
   * The object uses sha512 digests and the `content` directory, at the storage root's OCFL version.
   *
   * @throws {@link OcflError} `OBJECT_EXISTS` if an object with this id already exists.
   * @throws {@link OcflError} `DIRECTORY_NOT_EMPTY` if something appeared in the object's directory while its first version was being built. Nothing is created.
   * @throws {@link OcflError} `INVALID_OBJECT` if an invalid object declaration (E007), or more than one (E003), appeared in the object's directory while its first version was being built. Nothing is created.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id to a directory the file system can hold, with its lock in the workspace.
   * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if that directory holds something else, is a file or is below one, or is inside another object.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if another writer is creating the same object, or died creating it; `lockedAt` says since when, and is absent if the lock couldn't be read or was released meanwhile.
   * @throws {@link OcflError} `CROSS_FILESYSTEM_MOVE` if the workspace is on a different file system from the object.
   * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the storage root's file system doesn't support hard links. Nothing is changed.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if the create failed after its root inventory was put in place, failed putting it in place in a way that may have done so, or failed earlier and what it made couldn't all be removed; `cause` is the failure. The object may have been created, and stays locked. Also thrown, before `build` runs, if an earlier create left an unfinished version in the workspace, or the create was refused and its lock couldn't be released. Don't simply repeat the create: recover the object's unfinished write ({@link StorageRoot.unfinishedWrite}), then open the object to see whether it was created.
   * @throws `TypeError` if the id, the message or the user's name is missing or empty, the user's address isn't a string, `createdAt` isn't a valid `Date`,
   * `options` has a key other than `message`, `user`, `createdAt` and `signal`, its user has one other than `name` and `address`,
   * `options` isn't an object, or its `signal` isn't an `AbortSignal`. Nothing is created.
   * @throws `Error` if `build` returned while draft operations it started were still running. Await every operation.
   * @throws `options.signal.reason` if the signal is aborted before the commit begins, even if `build` caught the error a draft operation rejected with; nothing of the object is left, and it isn't locked. A signal already aborted is refused before the lock is taken.
   * @throws Whatever `build` or a draft operation throws; nothing of the object is left, and it isn't locked.
   * @throws The file system error that stopped the create before its root inventory was put in place; nothing is created.
   * @example
   * ```ts
   * const object = await root.create(id, { message: 'Initial deposit', user: { name: 'Alice' } }, async (draft) => {
   *   await draft.write('ro-crate-metadata.json', JSON.stringify(metadata));
   * });
   * ```
   */
  create(id: string, options: CreateOptions, build: (draft: Draft) => Promise<unknown>): Promise<OcflObject>;

  /**
   * Lists every object in the storage root, in no particular order. Each object is read when the listing reaches it, and yielded as `{ status: 'opened', object }`.
   * A damaged object root, one whose object can't be opened, is yielded as `{ status: 'damaged', error, objectRoot, id? }`, and the listing carries on.
   * A directory with an invalid object declaration is a damaged object root: it isn't searched for objects. So is an object whose OCFL version is later than the storage root's (E081).
   *
   * An object that another writer is creating and hasn't committed is left out, and so is the `extensions` directory.
   * Leaving the loop early closes every directory the listing opened.
   *
   * @throws The file system error that stopped the listing.
   * @example
   * ```ts
   * for await (const entry of root.objects()) {
   *   switch (entry.status) {
   *     case 'opened':
   *       await index(entry.object.id, entry.object.head.files);
   *       break;
   *     case 'damaged':
   *       console.warn(`${entry.objectRoot}: ${entry.error.code} ${entry.error.ocflCode ?? ''}`);
   *       break;
   *     default:
   *       console.warn('Unknown listed entry, skipped');
   *   }
   * }
   * ```
   */
  objects(): AsyncIterable<ListedObject>;

  /**
   * Deletes an object and all its versions, and the parent directories that leaves empty. The object's lock is held while it is deleted.
   *
   * @throws {@link OcflError} `OBJECT_NOT_FOUND` if there is no object with this id, or the layout can't map the id to a directory the file system can hold, so no object can have it; then `cause` is the layout's `ID_INCOMPATIBLE_WITH_LAYOUT`. Nothing is deleted.
   * @throws {@link OcflError} `UPDATE_IN_PROGRESS` if the object is being updated or created, or a writer died doing so; `lockedAt` says since when. Nothing is deleted. After a dead writer, recover its unfinished write ({@link StorageRoot.unfinishedWrite}) and then `remove` again.
   * @throws {@link OcflError} `UNSUPPORTED_FILESYSTEM` if the storage root's file system doesn't support hard links. Nothing is deleted.
   * @throws {@link OcflError} `INVALID_OBJECT` if the id's directory holds an object whose inventory is missing, corrupt or inconsistent, so its id can't be confirmed; nothing is deleted.
   * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the object's directory fits, but its lock in the workspace would be too long for the file system; nothing is deleted.
   * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if that directory holds an object with another id, or holds files that aren't an object, is a file or is below one; nothing is deleted.
   * @throws `TypeError` if the id is missing or empty.
   * @throws {@link OcflError} `RECOVERY_NEEDED` if deleting the object failed part of the way through, or it was deleted and its lock couldn't be released; `cause` is the failure. The object stays locked, and may be partly deleted: recovering its unfinished write ({@link StorageRoot.unfinishedWrite}) finishes removing it.
   * Also thrown if the remove was refused and its lock couldn't be released; nothing is deleted, and recovering only releases the lock, so `remove` again after it.
   * @throws The file system error that stopped the remove before it began deleting; nothing is deleted.
   * @example
   * ```ts
   * await root.remove('arcp://name,corpus/item/1');
   * ```
   */
  remove(id: string): Promise<void>;

  /**
   * Lists every unfinished write in the storage root, in no particular order: each create, update or remove whose lock is still held.
   * The library can't tell whether a write's writer is still working or died; `lockedAt` is what it offers towards deciding.
   * Nothing is changed.
   *
   * @throws The file system error that stopped the listing.
   * @example
   * ```ts
   * // After this host crashed: it was the storage root's only writer, so none of the writes before the crash is alive
   * for await (const write of root.unfinishedWrites()) {
   *   if (write.lockedAt < crashedAt) await write.recover();
   * }
   * ```
   */
  unfinishedWrites(): AsyncIterable<UnfinishedWrite>;

  /**
   * The unfinished write of an object: its create, update or remove whose lock is still held. Nothing is changed.
   *
   * @returns The write, or `undefined` if the object isn't locked or the layout can't map the id to a directory the file system can hold
   * @throws {@link OcflError} `OBJECT_ROOT_CONFLICT` if that directory is locked by a writer of another id.
   * @throws `TypeError` if the id is missing or empty.
   * @throws The file system error if the object's lock exists but can't be read.
   * @example
   * ```ts
   * const write = await root.unfinishedWrite(id);
   * if (write) console.log(`Locked since ${write.lockedAt.toISOString()}`);
   * ```
   */
  unfinishedWrite(id: string): Promise<UnfinishedWrite | undefined>;
}

/**
 * @returns The object root of `id`, relative to the storage root
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if the layout can't map the id, or maps it to the storage root, outside it, or into its extensions directory
 */
function mappedObjectPath(root: string, layout: BuiltInLayout, id: string): string {
  const mapped = layout.map(id);
  const relative = fileSystem.relativeWithin(root, nodePath.join(root, mapped));
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

/**
 * @param longest - The longest path the operation uses, given the object root
 * @returns The absolute object root of `id`
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` as {@link mappedObjectPath} does, or if `longest` is too long for the file system
 */
async function placedObjectRoot(root: string, layout: BuiltInLayout, id: string, longest: (objectRoot: string) => string): Promise<string> {
  return fittingObjectRoot(id, nodePath.join(root, mappedObjectPath(root, layout, id)), longest);
}

/**
 * @returns `objectRoot`
 * @throws {@link OcflError} `ID_INCOMPATIBLE_WITH_LAYOUT` if `longest` is too long for the file system
 */
async function fittingObjectRoot(id: string, objectRoot: string, longest: (objectRoot: string) => string): Promise<string> {
  if (!(await fileSystem.pathFits(longest(objectRoot)))) {
    throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `The object id <${id}> maps to a path too long for this file system.`);
  }
  return objectRoot;
}

const isUnplaceable = (error: unknown): error is OcflError => error instanceof OcflError && error.code === 'ID_INCOMPATIBLE_WITH_LAYOUT';

function storageRoot(root: string, ocflVersion: OcflSpecVersion, layout: BuiltInLayout, flusher: fileSystem.Flusher): StorageRoot {
  const settings: RootSettings = { ocflVersion, flusher };
  const longestWriterPathOf = (objectRoot: string) => longestWriterPath(root, objectRoot);
  /** The object root of `id`, or the layout's refusal if no object can have the id */
  const objectRootToRead = async (id: string): Promise<string | OcflError> => {
    try {
      return await placedObjectRoot(root, layout, id, (objectRoot) => objectRoot);
    } catch (error) {
      if (isUnplaceable(error)) {
        return error;
      }
      throw error;
    }
  };
  /** @throws {@link OcflError} `OBJECT_NOT_FOUND` if no object can have the id, with the layout's refusal as `cause` */
  const existingObjectRoot = async (id: string) => {
    const placed = await objectRootToRead(id);
    if (placed instanceof OcflError) {
      throw objectNotFound(root, id, placed);
    }
    return placed;
  };
  return deepFreeze({
    path: root,
    ocflVersion,
    layout: { extensionName: layout.name, ...layout.parameters } as Layout,
    async open(id: string) {
      return openObject(root, await existingObjectRoot(checkedId(id)), id, settings);
    },
    async has(id: string) {
      const placed = await objectRootToRead(checkedId(id));
      return !(placed instanceof OcflError) && (await objectState(root, placed)) === 'committed';
    },
    async create(id: string, options: CreateOptions, build: (draft: Draft) => Promise<unknown>) {
      const objectId = checkedId(id);
      const { details, signal } = writeOptions(options, 'root.create');
      signal?.throwIfAborted();
      return createObject(root, await placedObjectRoot(root, layout, objectId, longestWriterPathOf), objectId, settings, details, build, signal);
    },
    objects() {
      return listObjects(root, settings);
    },
    async remove(id: string) {
      const objectId = checkedId(id);
      const objectRoot = await existingObjectRoot(objectId);
      await removeObject(root, await fittingObjectRoot(objectId, objectRoot, longestWriterPathOf), objectId);
    },
    unfinishedWrites() {
      return listUnfinishedWrites(root, flusher, (id) => mappedObjectPath(root, layout, id));
    },
    async unfinishedWrite(id: string) {
      const placed = await objectRootToRead(checkedId(id));
      return placed instanceof OcflError ? undefined : findUnfinishedWrite(root, flusher, placed, id);
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
 * @throws `TypeError` if `path` is missing or empty, `options` isn't an object or has a key other than `layout` and `durability`, the layout or one of its parameters is invalid, or the durability isn't one.
 * @throws The file system error if the directory can't be made or written to.
 * @example
 * ```ts
 * const root = await createStorageRoot('/srv/ocfl', {
 *   layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
 * });
 * ```
 */
async function createStorageRoot(path: string, options: CreateStorageRootOptions): Promise<StorageRoot> {
  const root = absolutePath(path);
  const checked = optionsObject(options, 'createStorageRoot', ['layout', 'durability'], "{ layout: { extensionName: '0004-hashed-n-tuple-storage-layout' } }");
  const layout = createLayout(checked.layout as LayoutConfig);
  const flusher = checkedFlusher(checked.durability);
  const made = await fs.promises.mkdir(root, { recursive: true });
  if (!(await fileSystem.isDirEmpty(root))) {
    throw ocflError('DIRECTORY_NOT_EMPTY', `Cannot create a storage root in ${root}, which is not empty.`);
  }
  await writeStorageRoot(root, layout, flusher);
  if (made !== undefined) {
    // Each directory holding the name of one mkdir made
    await flusher.flush(...fileSystem.directoriesUpTo(nodePath.dirname(root), nodePath.dirname(made)));
  }
  return storageRoot(root, OCFL_VERSION, layout, flusher);
}

/**
 * Opens an existing storage root. Its layout is read from its own `ocfl_layout.json`.
 *
 * @throws {@link OcflError} `STORAGE_ROOT_NOT_FOUND` if `path` is missing, with no file above it, or is an empty directory; {@link createStorageRoot} can make a storage root there.
 * @throws {@link OcflError} `INVALID_STORAGE_ROOT` if anything else at `path` is not a storage root.
 * @throws {@link OcflError} `LAYOUT_NOT_DECLARED` if it is a storage root with no `ocfl_layout.json`; the message says to add one naming the storage layout, and lists the layouts this library implements.
 * @throws {@link OcflError} `UNSUPPORTED_LAYOUT` if it declares a layout this library doesn't implement; the message names it, lists the layouts this library implements, and says to ask for it to be added.
 * @throws `TypeError` if `path` is missing or empty, `options` isn't an object or has a key other than `durability`, or the durability isn't one.
 * @throws The file system error if `path` has no declaration and can't be read, or the storage root declaration, `ocfl_layout.json` or the storage layout's `config.json` exists but can't be read.
 * @example
 * ```ts
 * const root = await openStorageRoot('/srv/ocfl');
 * // A bulk load, which runs `sync` itself once it is done
 * const bulk = await openStorageRoot('/srv/ocfl', { durability: 'none' });
 * ```
 */
async function openStorageRoot(path: string, options: OpenStorageRootOptions = {}): Promise<StorageRoot> {
  const root = absolutePath(path);
  const flusher = checkedFlusher(optionsObject(options, 'openStorageRoot', ['durability'], "{ durability: 'none' }").durability);
  const { ocflVersion, layout } = await readStorageRoot(root);
  return storageRoot(root, ocflVersion, layout, flusher);
}

export { type CreateStorageRootOptions, createStorageRoot, type Durability, type OpenStorageRootOptions, openStorageRoot, type RootSettings, type StorageRoot };
