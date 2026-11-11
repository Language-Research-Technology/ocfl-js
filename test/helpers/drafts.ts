import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Inventory, LayoutConfig, OcflObject, StorageRoot, Version, VersionDetails } from '../../src/index.ts';
import { emptyDirectoriesUnder } from '../empty-directories.ts';

/** With this layout an object root is `<root>/<id>`, and a new storage root has no `extensions` directory */
export const FLAT: LayoutConfig = { extensionName: '0002-flat-direct-storage-layout' };

export const DETAILS: VersionDetails = { message: 'A test version', user: { name: 'Tester', address: 'mailto:tester@example.org' } };

/** The object root of `id` in a storage root with the {@link FLAT} layout */
export function objectRootOf(root: StorageRoot, id: string): string {
  return path.join(root.path, id);
}

/** Where a storage root assembles new versions: the object `id` has its version `vN` at `<workspace>/<object path>/vN` */
export function workspaceOf(root: StorageRoot): string {
  return path.join(root.path, 'extensions', 'ocfl-js-workspace');
}

/** Creates the object `id` with `files`, keyed by logical path */
export function createObject(root: StorageRoot, id: string, files: Record<string, string>): Promise<OcflObject> {
  return root.create(id, DETAILS, async (draft) => {
    for (const [logicalPath, content] of Object.entries(files)) {
      await draft.write(logicalPath, content);
    }
  });
}

/** The root inventory of the object at `objectRoot`, as it is on disk */
export async function readInventory(objectRoot: string): Promise<Inventory> {
  return JSON.parse(await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8'));
}

/** The text of each file of `version`, keyed by logical path */
export async function textFiles(version: Version): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Array.from(version.files, async ([logicalPath, file]) => [logicalPath, await file.text()])));
}

/** The content files stored under a version directory, relative to the object root, sorted */
export async function storedFiles(objectRoot: string, versionName: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(objectRoot, versionName), { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !/^inventory\.json/.test(e.name))
    .map((e) => path.relative(objectRoot, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Checks what a committed version must satisfy: its stored files are exactly the manifest's, each under its own digest,
 * and it has no empty directories.
 * @returns The root inventory
 */
export async function assertVersionValid(objectRoot: string, versionName: string): Promise<Inventory> {
  const inventory = await readInventory(objectRoot);
  const contentPaths = Object.values(inventory.manifest).flat();
  assert.strictEqual(new Set(contentPaths).size, contentPaths.length, 'a content path appears under two digests');
  assert.deepStrictEqual(await storedFiles(objectRoot, versionName), contentPaths.filter((p) => p.startsWith(`${versionName}/`)).sort());
  for (const [digest, paths] of Object.entries(inventory.manifest)) {
    for (const contentPath of paths) {
      const content = await fs.promises.readFile(path.join(objectRoot, contentPath));
      assert.strictEqual(createHash(inventory.digestAlgorithm).update(content).digest('hex'), digest, contentPath);
    }
  }
  assert.deepStrictEqual(await emptyDirectoriesUnder(path.join(objectRoot, versionName)), []);
  return inventory;
}

/** The content of every file under `dir`, keyed by its path relative to `dir`. Empty if `dir` doesn't exist. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const files = entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  return Object.fromEntries(await Promise.all(files.map(async (f) => [path.relative(dir, f), await fs.promises.readFile(f, 'utf8')])));
}
