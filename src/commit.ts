import fs from 'node:fs';
import path from 'node:path';
import { OCFL_CONSTANTS, type OcflSpecVersion } from './constants.ts';
import { objectDeclaration } from './declaration.ts';
import * as Hashing from './digest.ts';
import type { VersionDetails } from './draft.ts';
import { ocflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import type { OcflObjectInventory } from './inventory.ts';
import { type Lock, lockKept, releaseLock, takeLock } from './lock.ts';
import type { ObjectPlace } from './object-place.ts';
import { assertEmptyObjectRoot, declarationWithoutInventory, enclosingObject, objectExists, objectOutOfDate } from './object-root.ts';
import { specViolation } from './ocfl-rules.ts';
import {
  headOf,
  headOnDisk,
  isStagedRootInventory,
  type RootInventory,
  readInventory,
  readRootInventoryText,
  rootInventoryPaths,
  sidecarContent,
  sidecarDigest,
} from './root-inventory.ts';
import { isVersionName } from './version-number.ts';
import { clearWorkspace, removeAll } from './workspace.ts';

const { INVENTORY_NAME, OBJECT_DECLARATION_PREFIX, DECLARATION_TAG } = OCFL_CONSTANTS;
const FIRST_VERSION = 'v1';

/** How a write creates or updates its object */
interface WriteSettings {
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
  if (await objectDeclaration(root, { objectId: id, file: root })) {
    return;
  }
  if (!creating) {
    throw specViolation('E003', { objectId: id, file: root }, 'it has an inventory but no object declaration');
  }
  await assertEmptyObjectRoot(root, id);
  const declaration = OBJECT_DECLARATION_PREFIX + ocflVersion;
  const filePath = path.join(root, DECLARATION_TAG + declaration);
  await fileSystem.writeFile(filePath, `${declaration}\n`);
  return filePath;
}

/**
 * Checks that the version before the head of `inventory` is still the head on disk, in the root inventory it was made from.
 * @param inventory - Already at its new version
 * @param madeFrom - The digest of the root inventory `inventory` was made from, if it was made from one
 * @throws {@link OcflError} `OBJECT_EXISTS` if `inventory` is at its first version and the object now has a root inventory
 * @throws {@link OcflError} `OBJECT_OUT_OF_DATE` if the head on disk is any other version, or the root inventory has been replaced: the object purged and created again
 */
async function assertUpToDate(objectRoot: string, inventory: OcflObjectInventory, madeFrom: string | undefined): Promise<void> {
  const expected = inventory.versionNumber.previous()?.toString();
  const content = await readRootInventoryText(objectRoot);
  const actual = headOf(content);
  if (actual === expected) {
    if (content === undefined || madeFrom === undefined || (await Hashing.digest(inventory.digestAlgorithm, content)) === madeFrom) {
      return;
    }
    throw objectOutOfDate(inventory.id, expected, 'its root inventory has been replaced since');
  }
  if (expected === undefined) {
    throw objectExists(inventory.id);
  }
  const found = actual === undefined ? 'no root inventory' : actual === null ? 'a root inventory with no head' : `the head ${actual}`;
  throw objectOutOfDate(inventory.id, expected, `now has ${found}`);
}

/**
 * For an update that ended holding its lock: it may be committed, or may have left files behind.
 * @param cause - What the update failed with
 */
function recoveryNeeded(objectRoot: string, id: string, state: string, cause: unknown) {
  return lockKept(id, `The update of the object <${id}> at ${objectRoot} ${state}`, 'then open the object again before retrying', cause);
}

/** Renames the staged sidecar of the root inventory over its sidecar */
async function placeSidecar(objectRoot: string, digestAlgorithm: string): Promise<void> {
  const { sidecar, stagedSidecar } = rootInventoryPaths(objectRoot, digestAlgorithm);
  await fileSystem.move(stagedSidecar, sidecar);
}

/** Flushes the removal of what a write left in the object root, before its lock goes */
async function flushRemovals(flusher: fileSystem.Flusher, { objectRoot, storageRoot }: ObjectPlace): Promise<void> {
  await flusher.flush(await fileSystem.nearestExisting(objectRoot, storageRoot));
}

/**
 * A create or update of an object, from taking its lock to releasing it.
 * The write is committed when the root inventory is replaced. A failure before that discards everything
 * the write made and releases the object's lock. A failure after it, a failed replacement that may have
 * happened all the same, or a failure to discard, throws `RECOVERY_NEEDED` and keeps the lock.
 * What a write that died at any of these steps leaves is cleared by {@link recoverWrite}.
 */
export class ObjectWrite {
  #place: ObjectPlace;
  #settings: WriteSettings;
  #inventory: OcflObjectInventory;
  #madeFrom: RootInventory | undefined;
  #versionPath: string;
  #lock: Lock;
  #createdDeclaration: string | undefined;
  #rootInventoryPaths: ReturnType<typeof rootInventoryPaths>;
  #rootInventoryStaged = false;

  constructor(
    place: ObjectPlace,
    settings: WriteSettings,
    inventory: OcflObjectInventory,
    madeFrom: RootInventory | undefined,
    versionPath: string,
    lock: Lock,
  ) {
    this.#place = place;
    this.#settings = settings;
    this.#rootInventoryPaths = rootInventoryPaths(place.objectRoot, inventory.digestAlgorithm);
    this.#inventory = inventory;
    this.#madeFrom = madeFrom;
    this.#versionPath = versionPath;
    this.#lock = lock;
  }

  /** The inventory of the new version, which the draft changes */
  get inventory(): OcflObjectInventory {
    return this.#inventory;
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
   * @returns The committed root inventory
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if the commit failed after the root inventory was replaced, failed replacing it in a way that may have replaced it, or failed earlier and what it made can't be removed; `cause` is the failure
   */
  async commit(details: VersionDetails): Promise<RootInventory> {
    let replaced: { committed: RootInventory } | { unconfirmed: unknown };
    try {
      replaced = await this.#replaceRootInventory(details);
    } catch (error) {
      await this.discard({ error });
      throw error;
    }
    const { objectRoot, workspace, storageRoot } = this.#place;
    if ('unconfirmed' in replaced) {
      throw recoveryNeeded(
        objectRoot,
        this.#inventory.id,
        'may have been committed: replacing its root inventory failed, but may have taken effect',
        replaced.unconfirmed,
      );
    }
    try {
      await placeSidecar(objectRoot, this.#inventory.digestAlgorithm);
      // Keeps both renames: until the lock goes, recovery puts right a sidecar that outlived the root inventory
      await this.#settings.flusher.flush(objectRoot);
      await releaseLock(workspace, storageRoot);
    } catch (error) {
      throw recoveryNeeded(objectRoot, this.#inventory.id, "was committed, but couldn't be finished", error);
    }
    return replaced.committed;
  }

  /**
   * Removes everything this write made, including an object root it made and the layout directories above it that that leaves empty,
   * then releases the lock. Only before the root inventory is replaced: nothing puts a replaced root inventory back.
   * @param failure - What the write failed with, if it did, which the caller then throws
   * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the object's lock, if something the write made can't be removed; `cause` is the failure, or else what stopped the removal
   */
  async discard(failure?: { error: unknown }): Promise<void> {
    const { storageRoot, objectRoot, workspace } = this.#place;
    try {
      if (this.#rootInventoryStaged) {
        await fs.promises.rm(this.#rootInventoryPaths.stagedInventory, { recursive: true, force: true });
        await fs.promises.rm(this.#rootInventoryPaths.stagedSidecar, { recursive: true, force: true });
      }
      await fs.promises.rm(this.#versionPath, { recursive: true, force: true });
      if (this.#createdDeclaration) {
        await fs.promises.rm(this.#createdDeclaration, { recursive: true, force: true });
      }
      if (!this.#lock.objectRootExisted) {
        await fileSystem.removeEmptyAncestorsQuietly(objectRoot, storageRoot);
      }
      if (this.#createdDeclaration || this.#versionPath.startsWith(objectRoot + path.sep)) {
        await flushRemovals(this.#settings.flusher, this.#place);
      }
      await releaseLock(workspace, storageRoot);
    } catch (undoFailure) {
      throw recoveryNeeded(objectRoot, this.#inventory.id, "wasn't committed, and what it made couldn't all be removed", failure ? failure.error : undoFailure);
    }
  }

  /**
   * Every step of the commit up to its commit point, the replacement of the root inventory, which is the last thing this does.
   * @returns The root inventory committed, or the failure of a replacement that may have happened all the same, which mustn't be undone
   */
  async #replaceRootInventory(details: VersionDetails): Promise<{ committed: RootInventory } | { unconfirmed: unknown }> {
    const inventory = this.#inventory;
    const { storageRoot, objectRoot } = this.#place;
    const { ocflVersion, flusher } = this.#settings;
    const digestAlgorithm = inventory.digestAlgorithm;
    inventory._stamp((details.createdAt ?? new Date()).toISOString(), details.message, details.user);

    const objectVersionPath = path.join(objectRoot, inventory.head);
    const workspaceInvPath = path.join(this.#versionPath, INVENTORY_NAME);

    const inventoryContent = inventory.toString();
    const digest = await Hashing.digest(digestAlgorithm, inventoryContent);

    await fileSystem.writeFile(workspaceInvPath, inventoryContent);
    await fileSystem.writeFile(`${workspaceInvPath}.${digestAlgorithm}`, sidecarContent(digest));
    // Before anything in the object root changes, so a moved head never surfaces as a failed rename
    await assertUpToDate(objectRoot, inventory, this.#madeFrom?.digest);
    await flusher.flushTree(this.#versionPath);
    this.#createdDeclaration = await ensureObjectDeclaration(objectRoot, inventory.id, ocflVersion, this.#lock.operation === 'create');
    try {
      await fileSystem.move(this.#versionPath, objectVersionPath);
    } catch (error) {
      throw fileSystem.hasErrorCode(error, 'EXDEV')
        ? ocflError(
            'CROSS_FILESYSTEM_MOVE',
            `Can't move the new version of the object <${inventory.id}> into ${objectRoot}: it is on a different file system from the workspace.`,
            { objectId: inventory.id, cause: error },
          )
        : error;
    }
    this.#versionPath = objectVersionPath;
    const rootInv = this.#rootInventoryPaths;
    this.#rootInventoryStaged = true;
    const invPath = path.join(objectVersionPath, INVENTORY_NAME);
    await fileSystem.copyFile(invPath, rootInv.stagedInventory);
    await fileSystem.copyFile(`${invPath}.${digestAlgorithm}`, rootInv.stagedSidecar);
    // A create also makes the declaration, the object root and the layout's directories above it
    const holdingNames = this.#createdDeclaration ? [this.#createdDeclaration, ...fileSystem.directoriesUpTo(objectRoot, storageRoot)] : [objectRoot];
    await flusher.flush(rootInv.stagedInventory, rootInv.stagedSidecar, ...holdingNames);
    // A rename keeps it, and no other writer can replace the root inventory while this one holds the lock
    const identity = await fileSystem.identityOf(rootInv.stagedInventory);
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
      return { unconfirmed: error };
    }
    return { committed: { inventory, digest, identity } };
  }
}

/**
 * Takes the object's lock and makes, in the workspace, the directory for the version `inventory` is at.
 * @param inventory - Already at its new version
 * @param madeFrom - The root inventory `inventory` was made from, unless it is a first version
 * @throws {@link OcflError} `RECOVERY_NEEDED`, keeping the lock, if an earlier write left that directory behind, or the write was refused and its lock can't be released
 * @throws {@link OcflError} `OBJECT_EXISTS` or `OBJECT_OUT_OF_DATE`, as {@link assertUpToDate} does, releasing the lock
 */
export async function startWrite(place: ObjectPlace, settings: WriteSettings, inventory: OcflObjectInventory, madeFrom?: RootInventory): Promise<ObjectWrite> {
  const { storageRoot, objectRoot, workspace } = place;
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
      throw recoveryNeeded(objectRoot, inventory.id, "was refused, and its lock couldn't be released", error);
    }
    throw error;
  };
  // The lock's name, so that what the write leaves in the object root is never found without it
  await settings.flusher.flush(...fileSystem.directoriesUpTo(workspace, storageRoot)).catch(refuse);
  await assertUpToDate(objectRoot, inventory, madeFrom?.digest).catch(refuse);
  try {
    await fs.promises.mkdir(versionPath);
  } catch (error) {
    // Kept locked, so that what an earlier writer left there never becomes part of a version
    if (fileSystem.isAlreadyExists(error)) {
      throw lockKept(
        inventory.id,
        `The object <${inventory.id}> at ${objectRoot} can't be updated: an earlier update left ${versionPath} behind`,
        'then open the object again before retrying',
        error,
      );
    }
    return refuse(error);
  }
  return new ObjectWrite(place, settings, inventory, madeFrom, versionPath, lock);
}

/** The name an update of `inventory` gives its version, or `undefined` if there can be no further version */
function nextVersionName(inventory: OcflObjectInventory): string | undefined {
  return inventory.versionNumber.next()?.toString();
}

/** Replaces the sidecar of the root inventory if it doesn't record that inventory's digest */
async function completeSidecar(objectRoot: string, { inventory, digest }: RootInventory, flusher: fileSystem.Flusher): Promise<void> {
  const { sidecar, stagedSidecar } = rootInventoryPaths(objectRoot, inventory.digestAlgorithm);
  if (sidecarDigest(await fileSystem.readIfExists(sidecar)) === digest) {
    return;
  }
  await fileSystem.writeFile(stagedSidecar, sidecarContent(digest));
  await flusher.flush(stagedSidecar);
  await placeSidecar(objectRoot, inventory.digestAlgorithm);
}

/**
 * Clears what the dead create or update holding `lock` left of the object that the storage root's layout places at `place`, and releases the lock.
 * What was left before the commit point is discarded, and a committed update is completed. The lock goes last, so a failure keeps the object locked.
 *
 * Only what a dead writer can have left is removed from the object root: staged root inventory files, and the version after the head or,
 * with no root inventory, the declaration and first version of a create, and the object root and the layout directories above it that
 * that leaves empty if the lock says the create made them. A root inventory lost from a committed object with only a first version is
 * taken for a dead create too, whatever operation the lock records. A writer of an id whose directory holds another
 * object, or is inside one, was refused before it wrote anything there, so the object root is left alone.
 * @throws {@link OcflError} `INVALID_OBJECT` if the root inventory can't be used, or the object has a declaration and no root inventory but isn't what a dead create leaves; changing nothing
 */
export async function recoverWrite(place: ObjectPlace, lock: Lock, flusher: fileSystem.Flusher): Promise<void> {
  const { storageRoot, objectRoot, workspace } = place;
  const [root, rootNames, outer] = await Promise.all([readInventory(place), fileSystem.namesIn(objectRoot), enclosingObject(place)]);
  if (outer !== undefined || (root && root.inventory.id !== lock.id)) {
    await clearWorkspace(workspace);
    await releaseLock(workspace, storageRoot);
    return;
  }
  const declarations = rootNames.filter((name) => name.startsWith(DECLARATION_TAG + OBJECT_DECLARATION_PREFIX));
  // A create writes the declaration before anything else in the object root, so without one nothing there is its
  const createLeft = !root && declarations.length > 0;
  if (createLeft && rootNames.some((name) => isVersionName(name) && name !== FIRST_VERSION)) {
    throw declarationWithoutInventory(objectRoot, lock.id);
  }

  await clearWorkspace(workspace);
  if (root) {
    const next = nextVersionName(root.inventory);
    await removeAll(
      objectRoot,
      rootNames.filter((name) => isStagedRootInventory(name) || name === next),
    );
    await completeSidecar(objectRoot, root, flusher);
  } else {
    if (createLeft) {
      await removeAll(objectRoot, [...rootNames.filter((name) => isStagedRootInventory(name) || name === FIRST_VERSION), ...declarations]);
    }
    if (!lock.objectRootExisted) {
      await fileSystem.removeEmptyAncestors(objectRoot, storageRoot);
    }
  }
  await flushRemovals(flusher, place);
  await releaseLock(workspace, storageRoot);
}
