import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';
import { createStorageRoot, type Inventory, type LayoutConfig, type OcflObject, type StorageRoot, type Version, type VersionDetails } from '../../src/index.ts';
import { emptyDirectoriesUnder } from '../empty-directories.ts';

/** With this layout an object root is `<root>/<id>`, and a new storage root has no `extensions` directory */
export const FLAT: LayoutConfig = { extensionName: '0002-flat-direct-storage-layout' };

export const DETAILS: VersionDetails = { message: 'A test version', user: { name: 'Tester', address: 'mailto:tester@example.org' } };

export const sha512 = (content: string | Uint8Array): string => createHash('sha512').update(content).digest('hex');
export const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
export const streamOf = (content: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode(content));
      controller.close();
    },
  });

interface TempRoots {
  /** The suite's temp directory, once the suite has started */
  readonly dir: string;
  /** Creates a storage root in a new directory of `dir` */
  newRoot(layout?: LayoutConfig): Promise<StorageRoot>;
}

/** Gives the enclosing suite a temp directory, named from `prefix`, that is removed when the suite ends */
export function useTempRoots(prefix: string): TempRoots {
  let dir = '';
  let count = 0;
  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return {
    get dir() {
      return dir;
    },
    newRoot: (layout = FLAT) => createStorageRoot(path.join(dir, `root-${count++}`), { layout }),
  };
}

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

/**
 * Asserts that `object` reads the same as given and when opened afresh from `root`, and that its head version is valid on disk
 * @returns The root inventory
 */
export async function assertHolds(root: StorageRoot, object: OcflObject, expected: Record<string, string>): Promise<Inventory> {
  assert.deepStrictEqual(await textFiles(object.head), expected);
  assert.deepStrictEqual(await textFiles((await root.open(object.id)).head), expected);
  return assertVersionValid(objectRootOf(root, object.id), `v${object.head.number}`);
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
