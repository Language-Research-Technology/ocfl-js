import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';
import {
  createStorageRoot,
  type Draft,
  type LayoutConfig,
  type OcflErrorCode,
  type OcflObject,
  type StorageRoot,
  type Version,
  type VersionDetails,
} from '../../src/index.ts';
import type { Inventory } from '../../src/inventory.ts';
import { emptyDirectoriesUnder } from './empty-directories.ts';
import { ocflError } from './ocfl-error.ts';

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

/** The lock of the object `id` in a storage root with the {@link FLAT} layout */
export function lockOf(root: StorageRoot, id: string): string {
  return path.join(workspaceOf(root), id, 'lock');
}

/**
 * Leaves `id`, in a storage root with the {@link FLAT} layout, as a writer that died straight after taking its lock would
 * @param objectPath - Where another layout places `id`'s object root, relative to the storage root
 * @returns The lock
 */
export async function lockObject(root: StorageRoot, id: string, lockedAt: Date = new Date(), objectPath: string = id): Promise<string> {
  const lock = lockOf(root, objectPath);
  await fs.promises.mkdir(path.dirname(lock), { recursive: true });
  await fs.promises.writeFile(lock, JSON.stringify({ id, lockedAt: lockedAt.toISOString(), objectRootExisted: true }));
  return lock;
}

/** Recovers the unfinished write of `id`, which it must have, as a caller that knows its writer is dead does */
export async function recover(root: StorageRoot, id: string): Promise<void> {
  const write = await root.unfinishedWrite(id);
  assert.ok(write, `<${id}> has no unfinished write`);
  await write.recover();
}

/** Where the object `id`, its directory in the workspace and its lock are, or would be, in a storage root with the {@link FLAT} layout */
export function placesOf(root: StorageRoot, id: string): { objectRoot: string; workspace: string; lock: string } {
  return { objectRoot: objectRootOf(root, id), workspace: path.join(workspaceOf(root), id), lock: lockOf(root, id) };
}

/** Asserts that a storage root with the {@link FLAT} layout has no `extensions` directory, so no workspace is left */
export function assertNoWorkspace(root: StorageRoot): void {
  assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
}

export const writeB = (draft: Draft): Promise<void> => draft.write('b.txt', 'b');
export const writeC = (draft: Draft): Promise<void> => draft.write('c.txt', 'c');

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

/** Whether the root inventory of the object at `objectRoot` has the sha512 sidecar a commit writes for it */
export async function sidecarMatches(objectRoot: string): Promise<boolean> {
  const content = await fs.promises.readFile(path.join(objectRoot, 'inventory.json'), 'utf8');
  const sidecar = await fs.promises.readFile(path.join(objectRoot, 'inventory.json.sha512'), 'utf8').catch(() => undefined);
  return sidecar === `${sha512(content)} inventory.json`;
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
 * Checks what a committed version must satisfy: its stored files are exactly the manifest's, each under its own digest
 * and used by some version, and it has no empty directories.
 * @returns The root inventory
 */
export async function assertVersionValid(objectRoot: string, versionName: string): Promise<Inventory> {
  const inventory = await readInventory(objectRoot);
  const contentPaths = Object.values(inventory.manifest).flat();
  assert.strictEqual(new Set(contentPaths).size, contentPaths.length, 'a content path appears under two digests');
  assert.deepStrictEqual(await storedFiles(objectRoot, versionName), contentPaths.filter((p) => p.startsWith(`${versionName}/`)).sort());
  const usedDigests = new Set(Object.values(inventory.versions).flatMap((version) => Object.keys(version.state)));
  for (const [digest, paths] of Object.entries(inventory.manifest)) {
    assert.ok(usedDigests.has(digest), `${digest} is in the manifest but no version uses it`);
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

/** Every directory and file under `dir`, with the content of each file */
export async function everything(dir: string): Promise<{ paths: string[]; files: Record<string, string> }> {
  return { paths: (await fs.promises.readdir(dir, { recursive: true })).sort(), files: await snapshot(dir) };
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

/** Creates the object `id` in `root`, at v1 holding `a.txt`, and says where it is and what its object root holds */
export async function objectAtV1(root: StorageRoot, id: string) {
  const object = await createObject(root, id, { 'a.txt': 'a' });
  const places = placesOf(root, id);
  return { root, object, ...places, before: await snapshot(places.objectRoot) };
}

/** Asserts that `update` on `object` wrote nothing: no version, no workspace, the disk as it was */
export async function assertWritesNothing(root: StorageRoot, object: OcflObject, update: () => Promise<unknown>): Promise<void> {
  const objectRoot = objectRootOf(root, object.id);
  const before = await snapshot(objectRoot);
  await update();
  assert.deepStrictEqual(await snapshot(objectRoot), before);
  assert.ok(!fs.existsSync(path.join(objectRoot, `v${object.head.number + 1}`)));
  assert.ok(!fs.existsSync(workspaceOf(root)));
}

/** Asserts that `operation` rejects with `code` in an update of `object`, which then writes nothing and leaves the object as it was */
export async function assertRefuses(root: StorageRoot, object: OcflObject, operation: (draft: Draft) => Promise<void>, code: OcflErrorCode): Promise<void> {
  const files = await textFiles(object.head);
  await assertWritesNothing(root, object, async () => {
    const returned = await object.update(DETAILS, async (draft) => {
      await assert.rejects(operation(draft), ocflError(code));
    });
    assert.strictEqual(returned, object);
  });
  await assertHolds(root, object, files);
}

/** {@link assertRefuses} for a new object `id` holding `files` */
export async function assertRefusesWith(
  root: StorageRoot,
  id: string,
  files: Record<string, string>,
  operation: (draft: Draft) => Promise<void>,
  code: OcflErrorCode,
): Promise<void> {
  await assertRefuses(root, await createObject(root, id, files), operation, code);
}
