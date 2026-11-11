import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Inventory, loadStorage, type OcflStorageConfig } from '../../src/index.ts';
import { PATH_DIRECT } from './layouts.ts';

/** A storage root holding one object, <http://example.org/minimal_no_content>, laid out path-direct with no description of that layout */
export const STORAGE_FIXTURE: string = path.join(import.meta.dirname, '../shared/test-data/storage');

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
 * Writes an object into a storage root through the old API, as a `StorageRoot` can't create objects.
 * @returns The object's directory, relative to the storage root
 */
export async function writeObject(root: string, id: string): Promise<string> {
  return path.relative(root, await writeVersions(root, id, [{ 'a.txt': 'content' }]));
}

/** The OCFL fixture object, which has three versions */
export const SPEC_EX_FULL: string = path.join(import.meta.dirname, '../shared/test-data/fixtures/1.1/good-objects/spec-ex-full');
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

/**
 * Writes one version per entry of `versions` through the old API, as a `StorageRoot` can't write objects.
 * A `null` removes the file.
 * @returns The absolute path of the object's directory
 */
export async function writeVersions(
  root: string,
  id: string,
  versions: VersionFiles[],
  config: Omit<OcflStorageConfig, 'root' | 'layout'> = {},
): Promise<string> {
  const object = (await loadStorage({ ...config, root })).object(id);
  for (const files of versions) {
    await object.update(async (t) => {
      for (const [logicalPath, content] of Object.entries(files)) {
        await (content === null ? t.remove(logicalPath) : t.write(logicalPath, content));
      }
    });
  }
  return object.root;
}

/** Writes `content` as the root inventory of the object at `objectRoot`, with a sha512 sidecar that matches */
export async function writeInventory(objectRoot: string, content: string): Promise<void> {
  await writeFiles(objectRoot, {
    'inventory.json': content,
    'inventory.json.sha512': `${createHash('sha512').update(content).digest('hex')} inventory.json\n`,
  });
}

/** Rewrites the root inventory of the sha512 object at `objectRoot` as `change` leaves it, with a sidecar that matches */
export async function rewriteInventory(objectRoot: string, change: (inventory: Partial<Inventory>) => void): Promise<void> {
  const inventory: Partial<Inventory> = JSON.parse(await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8'));
  change(inventory);
  await writeInventory(objectRoot, JSON.stringify(inventory, null, 2));
}
