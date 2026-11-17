import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants, type OcflSpecVersion } from './constants.ts';
import * as Hashing from './digest.ts';
import type { VersionDetails } from './draft.ts';
import { ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { OcflObjectInventory } from './inventory.ts';
import { isStagedRootInventory, isVersionName, rootInventoryPaths, sidecarContent, sidecarDigest } from './inventory-files.ts';
import { type Lock, lockKept, releaseLock, takeLock } from './lock.ts';
import { assertEmptyObjectRoot, declarationWithoutInventory, enclosingObject, objectDeclaration, readInventory } from './object-on-disk.ts';
import { createError } from './ocfl-rules.ts';
import { parseJsonObject } from './utils.ts';
import { clearWorkspace, namesIn, objectWorkspace, removeAll } from './workspace.ts';

const { INVENTORY_NAME, NAMASTE_PREFIX_OBJECT, NAMASTE_T } = OcflConstants;
const FIRST_VERSION = 'v1';

/** Where the object a write creates or updates is */
interface ObjectPlace {
  /** Absolute path of the storage root, where removing empty directories stops */
  readonly storageRoot: string;
  /** Absolute path of the object root, inside the storage root */
  readonly objectRoot: string;
  /** Declared when the first commit creates the object */
  readonly ocflVersion: OcflSpecVersion;
  readonly flusher: fileSystem.Flusher;
}

/**
 * Writes the object declaration for a create into an empty object root; an update only checks that it is there
 * @returns The path of the declaration file, if this call wrote one
 * @throws {@link OcflError} `INVALID_OBJECT` with `E007` for an invalid declaration, or `E003` for more than one or if an update finds none; `OBJECT_ROOT_CONFLICT` if a create finds none in a directory that isn't empty
 */
async function ensureObjectDeclaration(root: string, id: string, ocflVersion: OcflSpecVersion, creating: boolean): Promise<string | undefined> {
  if (await objectDeclaration(root)) {
    return;
  }
  if (!creating) {
    throw createError('E003', root, 'it has an inventory but no object declaration');
  }
  await assertEmptyObjectRoot(root, id);
  const declaration = NAMASTE_PREFIX_OBJECT + ocflVersion;
  const filePath = path.join(root, NAMASTE_T + declaration);
  await fileSystem.writeFile(filePath, `${declaration}\n`);
  return filePath;
}

/** The head the root inventory `content` names: `undefined` if there is no root inventory, `null` if it names none */
function headOf(content: string | undefined): string | null | undefined {
  if (content === undefined) {
    return undefined;
  }
  const head = parseJsonObject(content)?.head;
  return typeof head === 'string' ? head : null;
}

function readRootInventory(objectRoot: string): Promise<string | undefined> {
  return fileSystem.readIfExists(path.join(objectRoot, INVENTORY_NAME));
}

/** The head the root inventory on disk names, as {@link headOf} gives it */
async function headOnDisk(objectRoot: string): Promise<string | null | undefined> {
  return headOf(await readRootInventory(objectRoot));
}

/**
 * Checks that the version before the head of `inventory` is still the head on disk, in the root inventory it was made from.
 * @param inventory - Already at its new version
 * @throws {@link OcflError} `OBJECT_EXISTS` if `inventory` is at its first version and the object now has a root inventory
 * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if the head on disk is any other version, or the root inventory has been replaced: the object removed and created again
 */
async function assertUpToDate(objectRoot: string, inventory: OcflObjectInventory): Promise<void> {
  const expected = inventory.versionNumber.previous()?.toString();
  const content = await readRootInventory(objectRoot);
  const actual = headOf(content);
  if (actual === expected) {
    const madeFrom = inventory._madeFrom;
    if (content === undefined || madeFrom === undefined || (await Hashing.digest(inventory.digestAlgorithm, content)) === madeFrom) {
      return;
    }
    throw ocflError(
      'OBJECT_OUT_OF_DATE',
      `The object at ${objectRoot} was opened at ${expected}, and its root inventory has been replaced since. Open it again and retry.`,
    );
  }
  if (expected === undefined) {
    throw ocflError('OBJECT_EXISTS', `There is already an object at ${objectRoot}.`);
  }
  const found = actual === undefined ? 'no root inventory' : actual === null ? 'a root inventory with no head' : `the head ${actual}`;
  throw ocflError('OBJECT_OUT_OF_DATE', `The object at ${objectRoot} was opened at ${expected}, and now has ${found}. Open it again and retry.`);
}

/**
 * For an update that ended holding its lock: it may be committed, or may have left files behind.
 * @param cause - What the update failed with
 */
function recoveryNeeded(objectRoot: string, state: string, cause: unknown) {
  return lockKept(`The update of the object at ${objectRoot} ${state}`, 'then open the object again before retrying', cause);
}

/** Renames the staged sidecar of the root inventory over its sidecar */
async function placeSidecar(objectRoot: string, digestAlgorithm: string): Promise<void> {
  const { sidecar, stagedSidecar } = rootInventoryPaths(objectRoot, digestAlgorithm);
  await fileSystem.move(stagedSidecar, sidecar);
}

/** Flushes the removal of what a write left in the object root, before its lock goes */
async function flushRemovals(flusher: fileSystem.Flusher, objectRoot: string, storageRoot: string): Promise<void> {
  await flusher.flush(await fileSystem.nearestExisting(objectRoot, storageRoot));
}

/**
 * A create or update of an object, from taking its lock to releasing it.
 * The write is committed when the root inventory is replaced. A failure before that discards everything
 * the write made and releases the object's lock. A failure after it, a failed replacement that may have
 * happened all the same, or a failure to discard, throws `RECOVERY_NEEDED` and keeps the lock.
 * What a write that died at any of these steps leaves is cleared by {@link recoverWrite}.
 */
class ObjectWrite {
  #place: ObjectPlace;
  #workspace: string;
  #inventory: OcflObjectInventory;
  #versionPath: string;
  #lock: Lock;
  #createdNamaste: string | undefined;
  #rootInventoryPaths: ReturnType<typeof rootInventoryPaths>;
  #rootInventoryStaged = false;

  constructor(place: ObjectPlace, workspace: string, inventory: OcflObjectInventory, versionPath: string, lock: Lock) {
    this.#place = place;
    this.#rootInventoryPaths = rootInventoryPaths(place.objectRoot, inventory.digestAlgorithm);
    this.#workspace = workspace;
    this.#inventory = inventory;
    this.#versionPath = versionPath;
    this.#lock = lock;
  }

  /**
   * The directory the new version is made in, in the workspace until the commit moves it into the object root.
   * The commit moves all of it, so by then it must hold only the version's content directory.
   */
  get versionPath(): string {
    return this.#versionPath;
  }

  /**
   * Saves the version as the object's new head.
   * @param details - Recorded in the version entry of the inventory
   * @returns The committed inventory
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if the commit failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made can't be removed; `cause` is the failure
   */
  async commit(details: VersionDetails): Promise<OcflObjectInventory> {
    let unconfirmed: { error: unknown } | undefined;
    try {
      unconfirmed = await this.#replaceRootInventory(details);
    } catch (error) {
      await this.discard({ error });
      throw error;
    }
    const objectRoot = this.#place.objectRoot;
    if (unconfirmed) {
      throw recoveryNeeded(objectRoot, 'may have been committed: replacing its root inventory failed, but may have taken effect', unconfirmed.error);
    }
    try {
      await placeSidecar(objectRoot, this.#inventory.digestAlgorithm);
      // Keeps both renames: until the lock goes, recovery puts right a sidecar that outlived the root inventory
      await this.#place.flusher.flush(objectRoot);
      await releaseLock(this.#workspace, this.#place.storageRoot);
    } catch (error) {
      throw recoveryNeeded(objectRoot, 'was committed, but could not be finished', error);
    }
    return this.#inventory;
  }

  /**
   * Removes everything this write made, including an object root it made and the layout directories above it that that leaves empty,
   * then releases the lock. Only before the root inventory is replaced: nothing puts a replaced root inventory back.
   * @param failure - What the write failed with, if it did, which the caller then throws
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if something the write made can't be removed; `cause` is the failure, or else what stopped the removal
   */
  async discard(failure?: { error: unknown }): Promise<void> {
    const { storageRoot, objectRoot } = this.#place;
    try {
      if (this.#rootInventoryStaged) {
        await fs.promises.rm(this.#rootInventoryPaths.stagedInventory, { recursive: true, force: true });
        await fs.promises.rm(this.#rootInventoryPaths.stagedSidecar, { recursive: true, force: true });
      }
      await fs.promises.rm(this.#versionPath, { recursive: true, force: true });
      if (this.#createdNamaste) {
        await fs.promises.rm(this.#createdNamaste, { recursive: true, force: true });
      }
      if (!this.#lock.objectRootExisted) {
        await fileSystem.removeEmptyAncestorsQuietly(objectRoot, storageRoot);
      }
      if (this.#createdNamaste || this.#versionPath.startsWith(objectRoot + path.sep)) {
        await flushRemovals(this.#place.flusher, objectRoot, storageRoot);
      }
      await releaseLock(this.#workspace, storageRoot);
    } catch (undoFailure) {
      throw recoveryNeeded(objectRoot, 'was not committed, and what it made could not all be removed', failure ? failure.error : undoFailure);
    }
  }

  /**
   * Every step of the commit up to its commit point, the replacement of the root inventory, which is the last thing this does.
   * @returns The failure of a replacement that may have happened all the same, which mustn't be undone
   */
  async #replaceRootInventory(details: VersionDetails): Promise<{ error: unknown } | undefined> {
    const inventory = this.#inventory;
    const { storageRoot, objectRoot, ocflVersion, flusher } = this.#place;
    const digestAlgorithm = inventory.digestAlgorithm;
    inventory._stamp((details.createdAt ?? new Date()).toISOString(), details.message, details.user);

    const objectVersionPath = path.join(objectRoot, inventory.head);
    const workspaceInvPath = path.join(this.#versionPath, INVENTORY_NAME);

    const inventoryContent = inventory.toString();
    inventory._digest = await Hashing.digest(digestAlgorithm, inventoryContent);

    await fileSystem.writeFile(workspaceInvPath, inventoryContent);
    await fileSystem.writeFile(`${workspaceInvPath}.${digestAlgorithm}`, sidecarContent(inventory));
    // Before anything in the object root changes, so a moved head never surfaces as a failed rename
    await assertUpToDate(objectRoot, inventory);
    await flusher.flushTree(this.#versionPath);
    this.#createdNamaste = await ensureObjectDeclaration(objectRoot, inventory.id, ocflVersion, this.#lock.operation === 'create');
    try {
      await fileSystem.move(this.#versionPath, objectVersionPath);
    } catch (error) {
      throw fileSystem.hasErrorCode(error, 'EXDEV')
        ? ocflError('CROSS_FILESYSTEM_MOVE', `Cannot move the new version into "${objectRoot}": it is on a different filesystem from the workspace.`)
        : error;
    }
    this.#versionPath = objectVersionPath;
    const rootInv = this.#rootInventoryPaths;
    this.#rootInventoryStaged = true;
    const invPath = path.join(objectVersionPath, INVENTORY_NAME);
    await fileSystem.copyFile(invPath, rootInv.stagedInventory);
    await fileSystem.copyFile(`${invPath}.${digestAlgorithm}`, rootInv.stagedSidecar);
    // A create also makes the declaration, the object root and the layout's directories above it
    const holdingNames = this.#createdNamaste ? [this.#createdNamaste, ...fileSystem.directoriesUpTo(objectRoot, storageRoot)] : [objectRoot];
    await flusher.flush(rootInv.stagedInventory, rootInv.stagedSidecar, ...holdingNames);
    // A rename keeps it, and no other writer can replace the root inventory while this one holds the lock
    inventory._identity = await fileSystem.identityOf(rootInv.stagedInventory);
    try {
      await fileSystem.move(rootInv.stagedInventory, rootInv.inventory);
    } catch (error) {
      // On NFS a rename can be applied though its reply is lost, so only the old head on disk, or for a create no root inventory, shows it
      // wasn't. A root inventory that can't be read or names no head counts as replaced
      const notReplaced = await headOnDisk(objectRoot).then(
        (head) => head === inventory.versionNumber.previous()?.toString(),
        () => false,
      );
      if (notReplaced) {
        throw error;
      }
      return { error };
    }
  }
}

/**
 * Takes the object's lock and makes, in the workspace, the directory for the version `inventory` is at.
 * @param inventory - Already at its new version
 * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the lock, if an earlier write left that directory behind, or the write was refused and its lock can't be released
 * @throws {@link OcflError} `OBJECT_EXISTS` or `OBJECT_OUT_OF_DATE`, as {@link assertUpToDate} does, releasing the lock
 */
async function startWrite(place: ObjectPlace, inventory: OcflObjectInventory): Promise<ObjectWrite> {
  const { storageRoot, objectRoot } = place;
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const rootExisted = await fs.promises.stat(objectRoot).then(
    () => true,
    () => false,
  );
  const operation = inventory.versionNumber.previous() === undefined ? 'create' : 'update';
  const lock = await takeLock(workspace, storageRoot, inventory.id, rootExisted, operation);
  const versionPath = path.join(workspace, inventory.head);
  const refuse = async (error: unknown): Promise<never> => {
    try {
      await releaseLock(workspace, storageRoot);
    } catch {
      throw recoveryNeeded(objectRoot, 'was refused, and its lock could not be released', error);
    }
    throw error;
  };
  // The lock's name, so that what the write leaves in the object root is never found without it
  await place.flusher.flush(...fileSystem.directoriesUpTo(workspace, storageRoot)).catch(refuse);
  await assertUpToDate(objectRoot, inventory).catch(refuse);
  try {
    await fs.promises.mkdir(versionPath);
  } catch (error) {
    // Kept locked, so that what an earlier writer left there never becomes part of a version
    if (fileSystem.isAlreadyExists(error)) {
      throw lockKept(
        `The object at ${objectRoot} can't be updated: an earlier update left ${versionPath} behind`,
        'then open the object again before retrying',
        error,
      );
    }
    return refuse(error);
  }
  return new ObjectWrite(place, workspace, inventory, versionPath, lock);
}

/** The name an update of `inventory` gives its version, or `undefined` if there can be no further version */
function nextVersionName(inventory: OcflObjectInventory): string | undefined {
  try {
    return inventory.versionNumber.next().toString();
  } catch {
    return undefined;
  }
}

/** Replaces the sidecar of the root inventory if it doesn't record that inventory's digest */
async function completeSidecar(objectRoot: string, inventory: OcflObjectInventory, flusher: fileSystem.Flusher): Promise<void> {
  const { sidecar, stagedSidecar } = rootInventoryPaths(objectRoot, inventory.digestAlgorithm);
  if (sidecarDigest(await fileSystem.readIfExists(sidecar)) === inventory._digest) {
    return;
  }
  await fileSystem.writeFile(stagedSidecar, sidecarContent(inventory));
  await flusher.flush(stagedSidecar);
  await placeSidecar(objectRoot, inventory.digestAlgorithm);
}

/**
 * Clears what the dead create or update holding `lock` left of the object that the storage root's layout places at `objectRoot`, and releases the lock.
 * What was left before the commit point is discarded, and a committed update is completed. The lock goes last, so a failure keeps the object locked.
 *
 * Only what a dead writer can have left is removed from the object root: staged root inventory files, and the version after the head or,
 * with no root inventory, the declaration and first version of a create, and the object root and the layout directories above it that
 * that leaves empty if the lock says the create made them. A root inventory lost from a committed object with only a first version is
 * taken for a dead create too, whatever operation the lock records. A writer of an id whose directory holds another
 * object, or is inside one, was refused before it wrote anything there, so the object root is left alone.
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, or the object has a declaration and no root inventory but isn't what a dead create leaves; changing nothing
 */
async function recoverWrite(storageRoot: string, objectRoot: string, lock: Lock, flusher: fileSystem.Flusher): Promise<void> {
  const workspace = objectWorkspace(storageRoot, objectRoot);
  const [inventory, rootNames, outer] = await Promise.all([
    readInventory(storageRoot, objectRoot),
    namesIn(objectRoot),
    enclosingObject(storageRoot, objectRoot),
  ]);
  if (outer !== undefined || (inventory && inventory.id !== lock.id)) {
    await clearWorkspace(workspace);
    await releaseLock(workspace, storageRoot);
    return;
  }
  const declarations = rootNames.filter((name) => name.startsWith(NAMASTE_T + NAMASTE_PREFIX_OBJECT));
  // A create writes the declaration before anything else in the object root, so without one nothing there is its
  const createLeft = !inventory && declarations.length > 0;
  if (createLeft && rootNames.some((name) => isVersionName(name) && name !== FIRST_VERSION)) {
    throw declarationWithoutInventory(objectRoot);
  }

  await clearWorkspace(workspace);
  if (inventory) {
    const next = nextVersionName(inventory);
    await removeAll(
      objectRoot,
      rootNames.filter((name) => isStagedRootInventory(name) || name === next),
    );
    await completeSidecar(objectRoot, inventory, flusher);
  } else {
    if (createLeft) {
      await removeAll(objectRoot, [...rootNames.filter((name) => isStagedRootInventory(name) || name === FIRST_VERSION), ...declarations]);
    }
    if (!lock.objectRootExisted) {
      await fileSystem.removeEmptyAncestors(objectRoot, storageRoot);
    }
  }
  await flushRemovals(flusher, objectRoot, storageRoot);
  await releaseLock(workspace, storageRoot);
}

export { type ObjectPlace, recoverWrite, startWrite };
