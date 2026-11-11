import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type OcflObject, openStorageRoot, type StorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import {
  assertVersionValid,
  createObject,
  DETAILS,
  objectRootOf,
  readInventory,
  snapshot,
  storedFiles,
  textFiles,
  useTempRoots,
  workspaceOf,
} from './helpers/drafts.ts';
import { PATH_DIRECT } from './helpers/layouts.ts';
import { SPEC_EX_FULL_ID, writeFiles, writeInventory, writeSpecExFullRoot, writeVersions } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';
import { DIGESTS_OF_ABC } from './shared/digests-of-abc.ts';

describe('updating an object made by another tool', () => {
  const temp = useTempRoots('ocfl-update-foreign-objects-');
  const { newRoot } = temp;

  /** Tries an update that would write a file, and reports whether its callback ran */
  async function attemptUpdate(object: OcflObject): Promise<{ result: Promise<OcflObject>; called: () => boolean }> {
    let called = false;
    const result = object.update(DETAILS, async (draft) => {
      called = true;
      await draft.write('b.txt', 'b');
    });
    await result.catch(() => {});
    return { result, called: () => called };
  }

  describe('with a mutable head (extension 0005)', () => {
    const headInventoryOf = (objectRoot: string) => path.join(objectRoot, 'extensions', '0005-mutable-head', 'head', 'inventory.json');

    async function objectWithHead(id: string): Promise<{ root: StorageRoot; objectRoot: string; headInventory: string }> {
      const root = await newRoot();
      await createObject(root, id, { 'a.txt': 'a' });
      const objectRoot = objectRootOf(root, id);
      const headInventory = headInventoryOf(objectRoot);
      await writeFiles(path.dirname(headInventory), { 'inventory.json': '{}' });
      return { root, objectRoot, headInventory };
    }

    it('throws MUTABLE_HEAD_ACTIVE without running the callback or leaving anything behind', async () => {
      const { root } = await objectWithHead('active-head');
      const initial = await snapshot(root.path);
      const { result, called } = await attemptUpdate(await root.open('active-head'));
      await assert.rejects(result, ocflError('MUTABLE_HEAD_ACTIVE'));
      assert.strictEqual(called(), false);
      assert.deepStrictEqual(await snapshot(root.path), initial);
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
    });

    it('leaves no lock, so the update works once the head is gone', async () => {
      const { root, headInventory } = await objectWithHead('head-removed');
      const object = await root.open('head-removed');
      await assert.rejects((await attemptUpdate(object)).result, ocflError('MUTABLE_HEAD_ACTIVE'));
      await fs.promises.rm(headInventory);
      const updated = await object.update(DETAILS, async (draft) => draft.write('b.txt', 'b'));
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(await textFiles((await root.open('head-removed')).head), { 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('updates an object whose extension directory has no head inventory', async () => {
      const { root, objectRoot, headInventory } = await objectWithHead('no-head-inventory');
      await fs.promises.rm(headInventory);
      const updated = await (await root.open('no-head-inventory')).update(DETAILS, async (draft) => draft.write('b.txt', 'b'));
      assert.strictEqual(updated.head.number, 2);
      assert.strictEqual((await readInventory(objectRoot)).head, 'v2');
    });

    it('rethrows when the head inventory cannot be checked, changing nothing', async () => {
      const { root, headInventory } = await objectWithHead('unreadable-head');
      await fs.promises.rm(headInventory);
      const object = await root.open('unreadable-head');
      const initial = await snapshot(root.path);
      const { result, called } = await withFsFailure('stat', headInventory, () => attemptUpdate(object), 'EACCES');
      await assert.rejects(result, { code: 'EACCES' });
      assert.strictEqual(called(), false);
      assert.deepStrictEqual(await snapshot(root.path), initial);
    });

    it('reports an object that has come to be nested in another object ahead of its mutable head', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      const object = await createObject(root, 'outer/inner', { 'a.txt': 'a' });
      const objectRoot = path.join(root.path, 'outer', 'inner');
      await writeFiles(path.dirname(headInventoryOf(objectRoot)), { 'inventory.json': '{}' });
      await writeFiles(path.join(root.path, 'outer'), { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
      const initial = await snapshot(root.path);
      const { result, called } = await attemptUpdate(object);
      await assert.rejects(result, ocflError('INVALID_OBJECT', 'E082'));
      assert.strictEqual(called(), false);
      assert.deepStrictEqual(await snapshot(root.path), initial);
    });
  });

  it('throws INVALID_OBJECT with E007 when the version declaration has come to hold the wrong contents', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'bad-declaration', { 'a.txt': 'a' });
    await fs.promises.writeFile(path.join(objectRootOf(root, 'bad-declaration'), '0=ocfl_object_1.1'), 'not a declaration\n');
    const initial = await snapshot(root.path);
    const { result, called } = await attemptUpdate(object);
    await assert.rejects(result, ocflError('INVALID_OBJECT', 'E007'));
    assert.strictEqual(called(), false);
    assert.deepStrictEqual(await snapshot(root.path), initial);
  });

  it('writes the new version of a sha256 object with a data content directory in sha256 and data', async () => {
    const root = await newRoot();
    const objectRoot = await writeVersions(root.path, 'sha256-data', [{ 'a.txt': 'a' }], { digestAlgorithm: 'sha256', contentDirectory: 'data' });
    const updated = await (await root.open('sha256-data')).update(DETAILS, async (draft) => draft.write('b.txt', 'abc'));

    assert.strictEqual(updated.digestAlgorithm, 'sha256');
    assert.strictEqual(updated.head.files.get('b.txt')!.digest, DIGESTS_OF_ABC.sha256);
    const reopened = await root.open('sha256-data');
    assert.strictEqual(reopened.digestAlgorithm, 'sha256');
    assert.deepStrictEqual(await textFiles(reopened.head), { 'a.txt': 'a', 'b.txt': 'abc' });

    assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/data/b.txt']);
    const inventory = await assertVersionValid(objectRoot, 'v2');
    assert.strictEqual(inventory.digestAlgorithm, 'sha256');
    assert.strictEqual(inventory.contentDirectory, 'data');
    assert.deepStrictEqual(inventory.manifest[DIGESTS_OF_ABC.sha256], ['v2/data/b.txt']);
    assert.deepStrictEqual(
      (await fs.promises.readdir(objectRoot)).filter((name) => name.startsWith('inventory.json.')),
      ['inventory.json.sha256'],
    );
    assert.ok(fs.existsSync(path.join(objectRoot, 'v2', 'inventory.json.sha256')));
  });

  it('keeps the fixity block of an inventory unchanged in the new version', async () => {
    const rootPath = path.join(temp.dir, 'spec-ex-full-root');
    await writeSpecExFullRoot(rootPath);
    const objectRoot = path.join(rootPath, 'spec-ex-full');
    const { fixity } = await readInventory(objectRoot);
    assert.deepStrictEqual(Object.keys(fixity!), ['md5', 'sha1']);

    const root = await openStorageRoot(rootPath);
    const updated = await (await root.open(SPEC_EX_FULL_ID)).update(DETAILS, async (draft) => draft.write('new.txt', 'abc'));

    assert.strictEqual(updated.head.number, 4);
    const inventory = await assertVersionValid(objectRoot, 'v4');
    assert.strictEqual(inventory.head, 'v4');
    assert.deepStrictEqual(inventory.fixity, fixity);
    assert.deepStrictEqual((await readInventory(path.join(objectRoot, 'v4'))).fixity, fixity);
  });

  describe('version names', () => {
    /** Writes an object with an empty version for each of `names`, the last being the head, as `root.open` needs it */
    async function objectWithVersions(id: string, names: string[]): Promise<{ root: StorageRoot; objectRoot: string; object: OcflObject }> {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, id);
      const version = { created: '2026-01-02T03:04:05Z', message: 'Made elsewhere', state: {}, user: { name: 'Another tool' } };
      await writeFiles(objectRoot, { '0=ocfl_object_1.1': 'ocfl_object_1.1\n' });
      await writeInventory(
        objectRoot,
        JSON.stringify({
          digestAlgorithm: 'sha512',
          head: names.at(-1),
          id,
          manifest: {},
          type: 'https://ocfl.io/1.1/spec/#inventory',
          versions: Object.fromEntries(names.map((name) => [name, version])),
        }),
      );
      return { root, objectRoot, object: await root.open(id) };
    }

    const padded = (width: number, to: number) => Array.from({ length: to }, (_, i) => `v${String(i + 1).padStart(width, '0')}`);
    const unpadded = (to: number) => Array.from({ length: to }, (_, i) => `v${i + 1}`);

    // A padded name must start with a zero (E011), so n digits hold versions up to 10^(n-1) - 1
    for (const [width, head] of [
      [2, 9],
      [2, 10],
      [2, 99],
      [3, 99],
    ] as const) {
      const names = padded(width, head);
      it(`throws VERSION_LIMIT_REACHED for ${names.at(-1)} beside ${names[0]}, without running the callback or writing anything`, async () => {
        const { root, object } = await objectWithVersions(`full-${width}-${head}`, names);
        assert.strictEqual(object.head.number, head);
        assert.deepStrictEqual(
          [...object.versions.keys()],
          names.map((_, i) => i + 1),
        );
        const initial = await snapshot(root.path);
        const { result, called } = await attemptUpdate(object);
        await assert.rejects(result, ocflError('VERSION_LIMIT_REACHED'));
        assert.strictEqual(called(), false);
        assert.deepStrictEqual(await snapshot(root.path), initial);
        assert.ok(!fs.existsSync(workspaceOf(root)));
      });
    }

    it('keeps the width of padded names below the limit, writing no version when nothing changes', async () => {
      const { root, objectRoot, object } = await objectWithVersions('padded', padded(3, 8));
      const ninth = await object.update(DETAILS, async (draft) => draft.write('a.txt', 'a'));
      assert.strictEqual(ninth.head.number, 9);
      assert.strictEqual((await readInventory(objectRoot)).head, 'v009');
      assert.strictEqual(await ninth.update(DETAILS, async (draft) => draft.write('a.txt', 'a')), ninth);
      assert.strictEqual((await readInventory(objectRoot)).head, 'v009');

      const tenth = await ninth.update(DETAILS, async (draft) => draft.write('b.txt', 'b'));
      assert.strictEqual(tenth.head.number, 10);
      assert.deepStrictEqual(await storedFiles(objectRoot, 'v010'), ['v010/content/b.txt']);
      assert.strictEqual(await tenth.update(DETAILS, async (draft) => draft.write('b.txt', 'b')), tenth);
      assert.strictEqual((await readInventory(objectRoot)).head, 'v010');

      const eleventh = await (await root.open('padded')).update(DETAILS, async (draft) => draft.write('c.txt', 'c'));
      assert.strictEqual(eleventh.head.number, 11);
      const inventory = await assertVersionValid(objectRoot, 'v011');
      assert.deepStrictEqual(Object.keys(inventory.versions), padded(3, 11));
      assert.deepStrictEqual(await textFiles((await root.open('padded')).head), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    });

    it('fills a padded object up to its last version, then throws VERSION_LIMIT_REACHED', async () => {
      const { objectRoot, object } = await objectWithVersions('nearly-full', padded(2, 8));
      const last = await object.update(DETAILS, async (draft) => draft.write('a.txt', 'a'));
      assert.strictEqual((await readInventory(objectRoot)).head, 'v09');
      await assert.rejects((await attemptUpdate(last)).result, ocflError('VERSION_LIMIT_REACHED'));
      assert.strictEqual((await readInventory(objectRoot)).head, 'v09');
    });

    for (const [head, next] of [
      [9, 10],
      [99, 100],
    ] as const) {
      it(`gives v${next} after v${head} when the names are not padded`, async () => {
        const { root, objectRoot, object } = await objectWithVersions(`unpadded-${head}`, unpadded(head));
        const updated = await object.update(DETAILS, async (draft) => draft.write('a.txt', 'a'));
        assert.strictEqual(updated.head.number, next);
        assert.strictEqual((await assertVersionValid(objectRoot, `v${next}`)).head, `v${next}`);
        assert.strictEqual((await root.open(`unpadded-${head}`)).head.number, next);
      });
    }
  });
});
