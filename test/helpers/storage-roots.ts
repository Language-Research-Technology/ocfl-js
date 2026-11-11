import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Draft, openStorageRoot } from '../../src/index.ts';
import type { Inventory } from '../../src/types.ts';
import { DETAILS } from './drafts.ts';
import { PATH_DIRECT } from './layouts.ts';
import { ocflError } from './ocfl-error.ts';

/** A storage root holding one object, <http://example.org/minimal_no_content>, laid out path-direct with no description of that layout */
export const STORAGE_FIXTURE: string = path.join(import.meta.dirname, '../fixtures/storage');

/** Names of the OCFL spec text files directly in `root` */
export async function specFiles(root: string): Promise<string[]> {
  return (await fs.promises.readdir(root)).filter((f) => /^ocfl_\d/.test(f));
}

/** Writes each file, keyed by its path relative to `dir`, making `dir` and any directories between */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  }
}

/**
 * Writes a storage root by hand, as another tool might leave it: its declaration and an `ocfl_layout.json`
 * naming the 0004 layout. The library itself only creates OCFL 1.1 roots.
 */
export async function writeStorageRoot(root: string, ocflVersion: '1.0' | '1.1'): Promise<void> {
  await writeFiles(root, {
    [`0=ocfl_${ocflVersion}`]: `ocfl_${ocflVersion}\n`,
    'ocfl_layout.json': JSON.stringify({ extension: '0004-hashed-n-tuple-storage-layout' }),
  });
}

/**
 * Writes a one-file object into a storage root.
 * @returns The object's directory, relative to the storage root
 */
export async function writeObject(root: string, id: string): Promise<string> {
  return path.relative(root, await writeVersions(root, id, [{ 'a.txt': 'content' }]));
}

/** The OCFL fixture object, which has three versions */
export const SPEC_EX_FULL: string = path.join(import.meta.dirname, '../fixtures/ocfl/1.1/good-objects/spec-ex-full');
export const SPEC_EX_FULL_ID = 'ark:/12345/bcd987';

/** Writes a storage root at `root` holding a copy of {@link SPEC_EX_FULL} in the directory `spec-ex-full` */
export async function writeSpecExFullRoot(root: string): Promise<void> {
  await writeFiles(root, {
    '0=ocfl_1.1': 'ocfl_1.1\n',
    'ocfl_layout.json': JSON.stringify({ extension: PATH_DIRECT }),
    [`extensions/${PATH_DIRECT}/config.json`]: JSON.stringify({ extensionName: PATH_DIRECT, replace: [[SPEC_EX_FULL_ID, 'spec-ex-full']], suffix: '' }),
  });
  await fs.promises.cp(SPEC_EX_FULL, path.join(root, 'spec-ex-full'), { recursive: true });
}

type VersionFiles = Record<string, string | Uint8Array | null>;

/** The directory of the object `id`, found in `root` by its declaration and inventory rather than by the layout */
async function findObjectRoot(root: string, id: string): Promise<string> {
  for (const entry of await fs.promises.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('0=ocfl_object_')) {
      const inventory = await fs.promises.readFile(path.join(entry.parentPath, 'inventory.json'), 'utf8').catch(() => '');
      // Other objects in the root may have been damaged on purpose
      if (inventory.includes(JSON.stringify(id))) {
        return entry.parentPath;
      }
    }
  }
  throw new Error(`No object <${id}> in ${root}`);
}

/**
 * Adds one version per entry of `versions` to the object `id`, creating it if need be. A `null` removes the file.
 * @returns The absolute path of the object's directory
 */
export async function writeVersions(root: string, id: string, versions: VersionFiles[]): Promise<string> {
  const storageRoot = await openStorageRoot(root);
  let object = await storageRoot.open(id).catch((error: unknown) => {
    if (ocflError('OBJECT_NOT_FOUND')(error)) {
      return undefined;
    }
    throw error;
  });
  for (const files of versions) {
    const change = async (draft: Draft) => {
      for (const [logicalPath, content] of Object.entries(files)) {
        await (content === null ? draft.remove(logicalPath) : draft.write(logicalPath, content));
      }
    };
    object = await (object ? object.update(DETAILS, change) : storageRoot.create(id, DETAILS, change));
  }
  return findObjectRoot(root, id);
}

/**
 * Writes a one-version OCFL 1.1 object at `objectRoot` by hand, as another tool might: the library itself only
 * creates sha512 objects with a `content` directory.
 */
export async function writeForeignObject(
  objectRoot: string,
  id: string,
  files: Record<string, string>,
  { digestAlgorithm, contentDirectory = 'content' }: { digestAlgorithm: 'sha256' | 'sha512'; contentDirectory?: string },
): Promise<void> {
  const digestOf = (content: string) => createHash(digestAlgorithm).update(content).digest('hex');
  const manifest: Record<string, string[]> = {};
  const state: Record<string, string[]> = {};
  const stored: Record<string, string> = {};
  for (const [logicalPath, content] of Object.entries(files)) {
    const digest = digestOf(content);
    if (!manifest[digest]) {
      manifest[digest] = [`v1/${contentDirectory}/${logicalPath}`];
      stored[`v1/${contentDirectory}/${logicalPath}`] = content;
    }
    state[digest] = [...(state[digest] ?? []), logicalPath];
  }
  const inventory = JSON.stringify({
    id,
    type: 'https://ocfl.io/1.1/spec/#inventory',
    digestAlgorithm,
    head: 'v1',
    contentDirectory,
    manifest,
    versions: { v1: { created: '2026-01-02T03:04:05Z', message: DETAILS.message, user: DETAILS.user, state } },
  });
  await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'ocfl_object_1.1\n', ...stored });
  await writeInventory(objectRoot, inventory, digestAlgorithm);
  await writeInventory(path.join(objectRoot, 'v1'), inventory, digestAlgorithm);
}

/** Writes `content` as the inventory in `dir`, an object root or version directory, with a sidecar that matches */
export async function writeInventory(dir: string, content: string, digestAlgorithm: 'sha256' | 'sha512' = 'sha512'): Promise<void> {
  await writeFiles(dir, {
    'inventory.json': content,
    [`inventory.json.${digestAlgorithm}`]: `${createHash(digestAlgorithm).update(content).digest('hex')} inventory.json\n`,
  });
}

/** `digests`, a manifest or state, with each digest in upper case */
export function upperCased(digests: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(digests).map(([digest, paths]) => [digest.toUpperCase(), paths]));
}

/** Rewrites the root inventory of the sha512 object at `objectRoot` as `change` leaves it, with a sidecar that matches */
export async function rewriteInventory(objectRoot: string, change: (inventory: Partial<Inventory>) => void): Promise<void> {
  const inventory: Partial<Inventory> = JSON.parse(await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8'));
  change(inventory);
  await writeInventory(objectRoot, JSON.stringify(inventory, null, 2));
}
