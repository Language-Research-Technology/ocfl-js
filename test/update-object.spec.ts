import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openStorageRoot } from '../src/index.ts';
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
import { HASHED } from './helpers/layouts.ts';
import { writeFiles, writeStorageRoot, writeVersions } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

describe('updating an object', () => {
  const temp = useTempRoots('ocfl-update-object-');
  const { newRoot } = temp;

  it('starts the draft with the files of the head version and writes one new version', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'an-object', { 'a.txt': 'a', 'dir/b.txt': 'b' });
    const updated = await object.update(DETAILS, async (draft) => {
      await draft.write('c.txt', 'c');
    });
    assert.strictEqual(updated.id, 'an-object');
    assert.strictEqual(updated.head.number, 2);
    assert.deepStrictEqual([...updated.versions.keys()], [1, 2]);
    assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'dir/b.txt': 'b', 'c.txt': 'c' });
    assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), { 'a.txt': 'a', 'dir/b.txt': 'b' });

    const objectRoot = objectRootOf(root, 'an-object');
    assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/c.txt']);
    await assertVersionValid(objectRoot, 'v2');
    assert.strictEqual((await readInventory(objectRoot)).head, 'v2');
    assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
  });

  it('returns a new object that matches the object opened afresh', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'returned', { 'a.txt': 'a' });
    const updated = await object.update(DETAILS, async (draft) => {
      await draft.write('a.txt', 'changed');
    });
    const opened = await root.open('returned');
    assert.notStrictEqual(updated, object);
    assert.ok(Object.isFrozen(updated));
    assert.strictEqual(opened.head.number, 2);
    assert.deepStrictEqual(await textFiles(opened.head), await textFiles(updated.head));
    assert.deepStrictEqual(await textFiles(opened.head), { 'a.txt': 'changed' });
    assert.strictEqual(updated.head.files.get('a.txt')!.digest, opened.head.files.get('a.txt')!.digest);
    assert.deepStrictEqual(updated.head.created, opened.head.created);
    assert.strictEqual(updated.ocflVersion, opened.ocflVersion);
    assert.strictEqual(updated.digestAlgorithm, opened.digestAlgorithm);
  });

  it('leaves the object it was called on as it was', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'unchanging', { 'a.txt': 'a' });
    const created = object.head.created;
    await object.update(DETAILS, async (draft) => {
      await draft.write('a.txt', 'changed');
      await draft.write('b.txt', 'b');
    });
    assert.strictEqual(object.head.number, 1);
    assert.deepStrictEqual([...object.versions.keys()], [1]);
    assert.deepStrictEqual(object.head.created, created);
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'a' });
  });

  it('updates an object that was opened, and the object an update returned', async () => {
    const root = await newRoot({ extensionName: HASHED });
    await createObject(root, 'http://example.org/chained', { 'a.txt': 'one' });
    const opened = await (await openStorageRoot(root.path)).open('http://example.org/chained');
    const second = await opened.update(DETAILS, async (draft) => {
      await draft.write('a.txt', 'two');
    });
    const third = await second.update(DETAILS, async (draft) => {
      await draft.write('a.txt', 'three');
    });
    assert.deepStrictEqual([...third.versions.keys()], [1, 2, 3]);
    const reopened = await root.open('http://example.org/chained');
    assert.deepStrictEqual(await Promise.all(Array.from(reopened.versions.values(), (version) => version.files.get('a.txt')!.text())), ['one', 'two', 'three']);
    assert.ok(!fs.existsSync(workspaceOf(root)));
  });

  it('records the message and user on the new version, leaving earlier versions as they were', async () => {
    const root = await newRoot();
    const object = await root.create('recorded', { message: 'first', user: { name: 'Alice', address: 'mailto:alice@example.org' } }, async (draft) => {
      await draft.write('a.txt', 'a');
    });
    const objectRoot = objectRootOf(root, 'recorded');
    const firstInventory = await readInventory(objectRoot);
    const firstVersion = await snapshot(path.join(objectRoot, 'v1'));

    const updated = await object.update({ message: 'second', user: { name: 'Bob' } }, async (draft) => {
      await draft.write('b.txt', 'b');
    });
    assert.strictEqual(updated.head.message, 'second');
    assert.deepStrictEqual(updated.head.user, { name: 'Bob' });
    assert.ok(updated.head.created.getTime() >= object.head.created.getTime());
    assert.strictEqual(updated.versions.get(1)!.message, 'first');
    assert.deepStrictEqual(updated.versions.get(1)!.user, { name: 'Alice', address: 'mailto:alice@example.org' });
    assert.deepStrictEqual(updated.versions.get(1)!.created, object.head.created);

    const inventory = await readInventory(objectRoot);
    assert.deepStrictEqual(inventory.versions.v1, firstInventory.versions.v1);
    assert.strictEqual(inventory.versions.v2?.message, 'second');
    assert.deepStrictEqual(inventory.versions.v2?.user, { name: 'Bob' });
    assert.deepStrictEqual(await snapshot(path.join(objectRoot, 'v1')), firstVersion);
    assert.deepStrictEqual(JSON.parse((await snapshot(path.join(objectRoot, 'v2')))['inventory.json']!), inventory);
  });

  it('stores content the object already holds once', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'deduplicated', { 'a.txt': 'same' });
    const updated = await object.update(DETAILS, async (draft) => {
      await draft.write('copy.txt', 'same');
      await draft.write('new-1.txt', 'new');
      await draft.write('new-2.txt', 'new');
    });
    const objectRoot = objectRootOf(root, 'deduplicated');
    assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), ['v2/content/new-1.txt']);
    await assertVersionValid(objectRoot, 'v2');
    assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'same', 'copy.txt': 'same', 'new-1.txt': 'new', 'new-2.txt': 'new' });
    assert.deepStrictEqual(await textFiles((await root.open('deduplicated')).head), await textFiles(updated.head));
  });

  describe('with no net change', () => {
    for (const [name, files] of [
      ['a draft that is left alone', {}],
      ['a draft given the content a file already has', { 'a.txt': 'a' }],
    ] as const) {
      it(`writes no version and returns the same object for ${name}`, async () => {
        const root = await newRoot();
        const object = await createObject(root, 'same', { 'a.txt': 'a' });
        const objectRoot = objectRootOf(root, 'same');
        const before = await snapshot(objectRoot);
        const returned = await object.update({ message: 'nothing', user: { name: 'Nobody' } }, async (draft) => {
          for (const [logicalPath, content] of Object.entries(files)) {
            await draft.write(logicalPath, content);
          }
        });
        assert.strictEqual(returned, object);
        assert.deepStrictEqual(await snapshot(objectRoot), before);
        assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
        assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
        assert.strictEqual((await root.open('same')).head.number, 1);
      });
    }

    it('writes a version for the next update that does change something', async () => {
      const root = await newRoot();
      const object = await createObject(root, 'then-changed', { 'a.txt': 'a' });
      const same = await object.update(DETAILS, async () => {});
      const updated = await same.update(DETAILS, async (draft) => {
        await draft.write('a.txt', 'changed');
      });
      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(await textFiles((await root.open('then-changed')).head), { 'a.txt': 'changed' });
    });
  });

  describe('OCFL version', () => {
    it('keeps a 1.0 object at 1.0 in a storage root that now declares 1.1', async () => {
      const rootPath = path.join(temp.dir, 'root-1.1-object-1.0');
      await writeStorageRoot(rootPath, '1.0');
      const objectRoot = await writeVersions(rootPath, 'http://example.org/object-1.0', [{ 'a.txt': 'abc' }]);
      await fs.promises.rm(path.join(rootPath, '0=ocfl_1.0'));
      await writeFiles(rootPath, { '0=ocfl_1.1': 'ocfl_1.1\n' });

      const root = await openStorageRoot(rootPath);
      assert.strictEqual(root.ocflVersion, '1.1');
      const object = await root.open('http://example.org/object-1.0');
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('b.txt', 'b');
      });
      assert.strictEqual(updated.ocflVersion, '1.0');
      assert.strictEqual((await root.open('http://example.org/object-1.0')).ocflVersion, '1.0');
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.0', 'inventory.json', 'inventory.json.sha512', 'v1', 'v2']);
      assert.strictEqual((await readInventory(objectRoot)).type, 'https://ocfl.io/1.0/spec/#inventory');
    });

    it('keeps a 1.1 object at 1.1', async () => {
      const root = await newRoot();
      const object = await createObject(root, 'object-1.1', { 'a.txt': 'a' });
      const updated = await object.update(DETAILS, async (draft) => {
        await draft.write('b.txt', 'b');
      });
      assert.strictEqual(updated.ocflVersion, '1.1');
      assert.strictEqual((await readInventory(objectRootOf(root, 'object-1.1'))).type, 'https://ocfl.io/1.1/spec/#inventory');
    });
  });

  for (const [name, details] of [
    ['no details', undefined],
    ['a missing message', { user: { name: 'Alice' } }],
    ['an empty message', { message: '', user: { name: 'Alice' } }],
    ['a missing user', { message: 'A change' }],
    ['a user with an empty name', { message: 'A change', user: { name: '' } }],
  ] as const) {
    it(`throws a TypeError for ${name}, writing nothing`, async () => {
      const root = await newRoot();
      const object = await createObject(root, 'undescribed', { 'a.txt': 'a' });
      const before = await snapshot(root.path);
      let called = false;
      const change = async () => {
        called = true;
      };
      await assert.rejects(object.update(details as never, change), TypeError);
      assert.ok(!called, 'the callback ran');
      assert.deepStrictEqual(await snapshot(root.path), before);
      assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));
    });
  }

  it('creates and updates objects side by side in one storage root', async () => {
    const root = await newRoot();
    const [first, second] = await Promise.all([createObject(root, 'first', { 'a.txt': '1' }), createObject(root, 'second', { 'a.txt': '2' })]);
    await Promise.all([
      first.update(DETAILS, async (draft) => draft.write('b.txt', 'first')),
      second.update(DETAILS, async (draft) => draft.write('b.txt', 'second')),
    ]);
    assert.deepStrictEqual(await textFiles((await root.open('first')).head), { 'a.txt': '1', 'b.txt': 'first' });
    assert.deepStrictEqual(await textFiles((await root.open('second')).head), { 'a.txt': '2', 'b.txt': 'second' });
    await assert.rejects(root.open('third'), ocflError('OBJECT_NOT_FOUND'));
  });
});
