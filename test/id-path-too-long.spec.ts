import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createStorageRoot, type StorageRoot } from '../src/index.ts';
import { createObject, everything, textFiles, useTempRoots, workspaceOf } from './helpers/drafts.ts';
import { PATH_DIRECT } from './helpers/layouts.ts';
import { ocflError } from './helpers/ocfl-error.ts';

/** Linux's PATH_MAX: the longest path, counting its terminating NUL */
const PATH_MAX = 4096;
/** The longest path a name can be looked up at */
const LONGEST_PATH = PATH_MAX - 1;
const OBJECT_SUFFIX = '/__object__';
const SEGMENT = 'x'.repeat(200);
const STAGED_LOCK_NAME = `/.lock-${randomUUID()}`;

const incompatible = ocflError('ID_INCOMPATIBLE_WITH_LAYOUT');

const bytes = (text: string): number => Buffer.byteLength(text);

/** A path-direct id, with every segment short enough to be a name, whose object root in `root` is `length` bytes long */
function idWithObjectRootOf(root: StorageRoot, length: number): string {
  const idLength = length - bytes(root.path) - 1 - OBJECT_SUFFIX.length;
  return Array(Math.ceil(idLength / (SEGMENT.length + 1)))
    .fill(SEGMENT)
    .join('/')
    .slice(0, idLength)
    .replace(/\/$/, 'x');
}

/** How much longer than its object root in `root` the content staged beside the object's lock in the workspace is */
function stagedLockExtra(root: StorageRoot): number {
  return bytes(workspaceOf(root)) - bytes(root.path) + STAGED_LOCK_NAME.length;
}

describe('an id whose paths are too long for the file system', () => {
  const temp = useTempRoots('ocfl-id-path-too-long-');

  const tooLong = (root: StorageRoot) => idWithObjectRootOf(root, PATH_MAX + 100);
  const lockTooLong = (root: StorageRoot) => idWithObjectRootOf(root, LONGEST_PATH - stagedLockExtra(root) + 1);
  const operations: Record<string, (root: StorageRoot, id: string) => Promise<unknown>> = {
    create: (root, id) => createObject(root, id, { 'a.txt': 'a' }),
    open: (root, id) => root.open(id),
    remove: (root, id) => root.remove(id),
    unfinishedWrite: (root, id) => root.unfinishedWrite(id),
  };
  const refusals: [string, (root: StorageRoot) => string, string[]][] = [
    ['whose object root is too long', tooLong, ['create', 'open', 'remove', 'unfinishedWrite']],
    ['whose object root fits, but whose lock in the workspace does not', lockTooLong, ['create', 'remove']],
  ];

  for (const [which, idOf, names] of refusals) {
    for (const name of names) {
      it(`${name} throws ID_INCOMPATIBLE_WITH_LAYOUT for an id ${which}, touching nothing`, async () => {
        const root = await temp.newRoot({ extensionName: PATH_DIRECT });
        const before = await everything(path.dirname(root.path));

        await assert.rejects(operations[name]!(root, idOf(root)), incompatible);

        assert.deepStrictEqual(await everything(path.dirname(root.path)), before);
      });
    }
  }

  describe('whose object root fits, but whose lock in the workspace does not', () => {
    it('finds no object and no unfinished write when nothing is there', async () => {
      const root = await temp.newRoot({ extensionName: PATH_DIRECT });
      const id = lockTooLong(root);

      await assert.rejects(root.open(id), ocflError('OBJECT_NOT_FOUND'));
      assert.strictEqual(await root.unfinishedWrite(id), undefined);
    });

    it('opens the object another tool wrote there', async () => {
      const root = await createStorageRoot(path.join(temp.dir, 'd'.repeat(100), 'root'), { layout: { extensionName: PATH_DIRECT } });
      const id = lockTooLong(root);
      const shallower = await temp.newRoot({ extensionName: PATH_DIRECT });
      await createObject(shallower, id, { 'a.txt': 'a' });
      const [top = ''] = id.split('/');
      await fs.promises.rename(path.join(shallower.path, top), path.join(root.path, top));

      assert.deepStrictEqual(await textFiles((await root.open(id)).head), { 'a.txt': 'a' });
      assert.strictEqual(await root.unfinishedWrite(id), undefined);
      await assert.rejects(root.remove(id), incompatible);
    });
  });

  it('leaves the longest id that fits to create, open and remove', async () => {
    const root = await temp.newRoot({ extensionName: PATH_DIRECT });
    const id = idWithObjectRootOf(root, LONGEST_PATH - stagedLockExtra(root));

    await createObject(root, id, { 'a.txt': 'a' });
    assert.deepStrictEqual(await textFiles((await root.open(id)).head), { 'a.txt': 'a' });
    assert.strictEqual(await root.unfinishedWrite(id), undefined);
    await root.remove(id);
    await assert.rejects(root.open(id), ocflError('OBJECT_NOT_FOUND'));
  });

  it("doesn't blame the id when a file the draft writes has a path too long", async () => {
    const root = await temp.newRoot({ extensionName: PATH_DIRECT });
    const logicalPath = Array(20).fill('y'.repeat(250)).join('/');
    const before = await everything(root.path);

    await assert.rejects(createObject(root, 'a', { [logicalPath]: 'a' }), { code: 'ENAMETOOLONG' });

    assert.deepStrictEqual(await everything(root.path), before);
  });
});
