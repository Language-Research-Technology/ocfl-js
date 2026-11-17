import fs from 'node:fs';
import nodePath from 'node:path';
import { OcflConstants } from './constants.ts';
import type { DigestAlgorithm } from './digest.ts';
import * as Hashing from './digest.ts';
import type { OcflError } from './error.ts';
import * as fileSystem from './file-system.ts';
import { type Inventory, OcflObjectInventory, validateStoredInventory, versionNumbers } from './inventory.ts';
import { isLocked } from './lock.ts';
import type { ObjectPlace } from './object-place.ts';
import { specViolation } from './ocfl-rules.ts';
import { isJsonObject, parseJsonObject } from './utils.ts';
import { isVersionName, VersionNumber } from './version-number.ts';

const { INVENTORY_NAME } = OcflConstants;

/** An object's root inventory as stored: read from its object root, or committed there */
interface RootInventory {
  readonly inventory: OcflObjectInventory;
  /** Of the inventory's bytes, as its sidecar records it */
  readonly digest: string;
  /** Of the root inventory file */
  readonly identity: fileSystem.FileIdentity;
}

/** The digest an inventory sidecar records, normalised, if it records one */
function sidecarDigest(sidecar: string | undefined): string | undefined {
  const recorded = sidecar?.match(/\S+/)?.[0];
  return recorded === undefined ? undefined : Hashing.normaliseDigest(recorded);
}

/** What the sidecar of an inventory of digest `digest` holds */
function sidecarContent(digest: string): string {
  return `${digest} ${INVENTORY_NAME}`;
}

/** The root inventory and its sidecar, and where a commit stages each before renaming it into place */
function rootInventoryPaths(objectRoot: string, digestAlgorithm: string): Record<'inventory' | 'sidecar' | 'stagedInventory' | 'stagedSidecar', string> {
  const inventory = nodePath.join(objectRoot, INVENTORY_NAME);
  const sidecar = `${inventory}.${digestAlgorithm}`;
  return { inventory, sidecar, stagedInventory: `${inventory}.tmp`, stagedSidecar: `${sidecar}.tmp` };
}

/** Whether `name` is a staged file of {@link rootInventoryPaths}, for any digest algorithm */
function isStagedRootInventory(name: string): boolean {
  return /^inventory\.json(\.[^.]+)?\.tmp$/.test(name);
}

/**
 * @throws {@link OcflError} `INVALID_OBJECT` if the versions of `inventory`, read from `file`, can't be listed: with `E011` or `E012` for
 * names that mix zero-padding conventions, `E009` or `E010` for numbers that don't run 1, 2, 3…, `E049` for a version with no valid created
 * time, or `E040` for a head that isn't the latest version
 */
function checkVersions(inventory: OcflObjectInventory, file: string): void {
  const widths = new Map(Object.keys(inventory.versions).map((name) => [VersionNumber._fromString(name).zeroPaddingLength, name]));
  if (widths.size > 1) {
    const unpadded = widths.get(undefined);
    throw unpadded === undefined
      ? specViolation('E012', file, `zero-padded versions of different widths: ${[...widths.values()].sort().join(', ')}`)
      : specViolation('E011', file, `${unpadded} among zero-padded versions`);
  }
  let previous = 0;
  for (const [number, name] of versionNumbers(inventory)) {
    if (number !== previous + 1) {
      throw previous === 0 ? specViolation('E009', file, `the first version is ${name}`) : specViolation('E010', file, `no version ${previous + 1}`);
    }
    previous = number;
    const created = inventory.versions[name]?.created;
    if (typeof created !== 'string' || Number.isNaN(new Date(created).getTime())) {
      throw specViolation('E049', file, `no valid created time for version ${name}`);
    }
  }
  if (inventory.versionNumber.value !== previous) {
    throw specViolation('E040', file, `head "${inventory.head}" is not the latest version`);
  }
}

/**
 * Whether the root inventory `text`, of digest `digest`, is the inventory of its head version `head`, as that version's own sidecar confirms.
 * A commit replaces the root inventory and then its sidecar, so between the two the root inventory is right and its sidecar is not.
 */
async function isHeadVersionInventory(objectRoot: string, head: unknown, text: string, digestAlgorithm: DigestAlgorithm, digest: string): Promise<boolean> {
  // Not yet validated, so it could name anything
  if (typeof head !== 'string' || !isVersionName(head)) {
    return false;
  }
  const file = nodePath.join(objectRoot, head, INVENTORY_NAME);
  const [inventory, sidecar] = await Promise.all([fileSystem.readIfPresent(file), fileSystem.readIfPresent(`${file}.${digestAlgorithm}`)]);
  return inventory === text && sidecarDigest(sidecar) === digest;
}

/**
 * The id the root inventory of the object at `objectRoot` names, unchecked, for an object that can't be opened.
 * @returns `undefined` if the inventory can't be read, isn't JSON, or its `id` isn't a string
 */
async function idInRootInventory(objectRoot: string): Promise<string | undefined> {
  const text = await fs.promises.readFile(nodePath.join(objectRoot, INVENTORY_NAME), 'utf8').catch(() => undefined);
  const id = text === undefined ? undefined : parseJsonObject(text)?.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Reads the root inventory of the object at `place`, and checks it against its sidecar.
 * While another writer holds the object's lock, a commit may be replacing the sidecar, so the inventory of its head version is accepted instead.
 * @param options.callerHoldsLock - Whether the caller holds the lock, so no other writer can be committing
 * @returns `undefined` if there is no inventory
 * @throws {@link OcflError} `INVALID_OBJECT` if the inventory or its sidecar is missing, corrupt or inconsistent, its id is missing or
 * empty (`E036`), or its versions break a rule {@link checkVersions} checks
 */
function readInventory(place: ObjectPlace, options: { callerHoldsLock?: boolean } = {}): Promise<RootInventory | undefined> {
  return readInventoryAttempt(place, options.callerHoldsLock ? 'own lock' : 'first read');
}

/** `E058` or `E060` for the root inventory `file`, of digest `actual`, whose sidecar `sidecar` records `recorded` */
function sidecarRefusal(file: string, digestAlgorithm: DigestAlgorithm, sidecar: string | undefined, recorded: string | undefined, actual: string): OcflError {
  return sidecar === undefined
    ? specViolation('E058', file, `no ${digestAlgorithm} sidecar`)
    : specViolation('E060', file, `recorded=${recorded} actual=${actual}`);
}

/**
 * {@link readInventory}. On a `'first read'` with no lock held, a sidecar that only a commit explains is read once more, as its
 * writer may have replaced the sidecar and released the lock since the sidecar was read.
 */
async function readInventoryAttempt(place: ObjectPlace, attempt: 'first read' | 'second read' | 'own lock'): Promise<RootInventory | undefined> {
  const { objectRoot } = place;
  const file = nodePath.join(objectRoot, INVENTORY_NAME);
  const read = await fileSystem.readWithIdentity(file);
  if (read === undefined) {
    return undefined;
  }
  const { text, identity } = read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw specViolation('E033', file, 'not valid JSON', { cause });
  }
  if (!isJsonObject(parsed)) {
    throw specViolation('E033', file, 'not a JSON object');
  }
  const data = parsed as unknown as Inventory;
  const digestAlgorithm: unknown = data.digestAlgorithm;
  if (digestAlgorithm !== 'sha256' && digestAlgorithm !== 'sha512') {
    throw specViolation('E025', file, 'digestAlgorithm is not sha256 or sha512');
  }
  const sidecar = await fileSystem.readIfPresent(`${file}.${digestAlgorithm}`);
  const recorded = sidecarDigest(sidecar);
  const actual = await Hashing.digest(digestAlgorithm, text);
  let inventory: OcflObjectInventory;
  try {
    if (recorded !== actual) {
      const committing = attempt !== 'own lock' && (await isLocked(place.workspace));
      const mayRetry = attempt === 'first read' && !committing;
      if (!(committing || mayRetry) || !(await isHeadVersionInventory(objectRoot, data.head, text, digestAlgorithm, actual))) {
        throw sidecarRefusal(file, digestAlgorithm, sidecar, recorded, actual);
      }
      if (mayRetry) {
        return readInventoryAttempt(place, 'second read');
      }
    }
    validateStoredInventory(data, file);
    if (typeof data.head !== 'string') {
      throw specViolation('E040', file, 'head is not a string');
    }
    if (typeof data.id !== 'string') {
      throw specViolation('E036', file, 'missing id');
    }
    if (data.id === '') {
      throw specViolation('E036', file, 'empty id');
    }
    inventory = new OcflObjectInventory(data, file);
  } catch (cause) {
    // The inventory isn't shaped as the checks assume
    if (cause instanceof TypeError) {
      throw specViolation('E033', file, 'malformed', { cause });
    }
    throw cause;
  }
  checkVersions(inventory, file);
  return { inventory, digest: actual, identity };
}

export { idInRootInventory, isStagedRootInventory, type RootInventory, readInventory, rootInventoryPaths, sidecarContent, sidecarDigest };
