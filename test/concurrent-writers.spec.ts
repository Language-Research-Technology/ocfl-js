import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { type Draft, OcflError, type OcflObject, type StorageRoot } from '../src/index.ts';
import { emptyDirectoriesUnder } from './empty-directories.ts';
import { fsError, withFsFailure } from './fs-failures.ts';
import { createObject, DETAILS, objectRootOf, snapshot, textFiles, useTempRoots, workspaceOf } from './helpers/drafts.ts';
import { rewriteInventory } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';

const ID = 'contended';

const writeB = (draft: Draft) => draft.write('b.txt', 'b');
const writeC = (draft: Draft) => draft.write('c.txt', 'c');

/** The lock of the object `id` in a storage root with the flat layout */
const lockOf = (root: StorageRoot, id = ID) => path.join(workspaceOf(root), id, 'lock');

/** The rejection of `promise`, which must be an `OcflError` */
async function rejection(promise: Promise<unknown>): Promise<OcflError> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof OcflError, String(error));
  return error;
}

/** Runs `fn` with `beforeOpen` called once, just before the first file at `file` is opened */
async function beforeOpening<T>(file: string, beforeOpen: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const real = fs.promises.open;
  let called = false;
  const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
    if (!called && String(args[0]) === file) {
      called = true;
      await beforeOpen();
    }
    return real.apply(fs.promises, args);
  });
  try {
    const result = await fn();
    assert.ok(called, `${file} was never opened`);
    return result;
  } finally {
    spy.mock.restore();
  }
}

describe('concurrent writers', () => {
  const { newRoot } = useTempRoots('ocfl-concurrent-writers-');
  afterEach(() => {
    mock.restoreAll();
  });

  const assertNoWorkspace = (root: StorageRoot) => assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));

  /** A storage root holding the object {@link ID} at v1 */
  async function existingObject() {
    const root = await newRoot();
    const object = await createObject(root, ID, { 'a.txt': 'a' });
    return { root, object, objectRoot: objectRootOf(root, ID) };
  }

  /** {@link existingObject}, with a second version committed since `stale` was opened */
  async function outOfDateObject() {
    const existing = await existingObject();
    const current = await existing.object.update(DETAILS, writeB);
    return { ...existing, stale: existing.object, current };
  }

  describe('a second writer of a locked object', () => {
    it('is refused with UPDATE_IN_PROGRESS when it updates from inside another update, and changes nothing', async () => {
      const { root, object, objectRoot } = await existingObject();
      let secondRan = false;

      const updated = await object.update(DETAILS, async (draft) => {
        await writeB(draft);
        const before = await snapshot(root.path);
        await assert.rejects(
          object.update(DETAILS, async (second) => {
            secondRan = true;
            await writeC(second);
          }),
          ocflError('UPDATE_IN_PROGRESS'),
        );
        assert.deepStrictEqual(await snapshot(root.path), before);
      });

      assert.strictEqual(secondRan, false);
      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b' });
      assert.deepStrictEqual((await fs.promises.readdir(objectRoot)).sort(), ['0=ocfl_object_1.1', 'inventory.json', 'inventory.json.sha512', 'v1', 'v2']);
      assertNoWorkspace(root);
    });

    it('is told when the lock was taken', async () => {
      const { object } = await existingObject();
      const started = Date.now();

      await object.update(DETAILS, async (draft) => {
        await writeB(draft);
        const { lockedAt } = await rejection(object.update(DETAILS, writeC));
        const failed = Date.now();
        assert.ok(lockedAt instanceof Date);
        assert.ok(lockedAt.getTime() >= started, `${lockedAt.toISOString()} is before the first writer started`);
        assert.ok(lockedAt.getTime() <= failed, `${lockedAt.toISOString()} is after the second writer failed`);
      });
    });

    it('is refused with UPDATE_IN_PROGRESS even when it holds an out-of-date object', async () => {
      const { stale, current } = await outOfDateObject();

      const updated = await current.update(DETAILS, async (draft) => {
        await writeC(draft);
        await assert.rejects(stale.update(DETAILS, writeC), ocflError('UPDATE_IN_PROGRESS'));
      });

      assert.strictEqual(updated.head.number, 3);
    });

    it('is refused when it creates the object from inside another create, which gives one object', async () => {
      const root = await newRoot();

      const created = await root.create(ID, DETAILS, async (draft) => {
        await writeB(draft);
        const { code } = await rejection(root.create(ID, DETAILS, writeC));
        assert.ok(code === 'UPDATE_IN_PROGRESS' || code === 'OBJECT_EXISTS', code);
      });

      for (const object of [created, await root.open(ID)]) {
        assert.deepStrictEqual([...object.versions.keys()], [1]);
        assert.deepStrictEqual(await textFiles(object.head), { 'b.txt': 'b' });
      }
      assertNoWorkspace(root);
    });

    it('is told when the lock was taken by a writer creating the object', async () => {
      const root = await newRoot();
      const started = Date.now();

      await root.create(ID, DETAILS, async (draft) => {
        await writeB(draft);
        const { code, lockedAt } = await rejection(root.create(ID, DETAILS, writeC));
        assert.strictEqual(code, 'UPDATE_IN_PROGRESS');
        assert.ok(lockedAt instanceof Date);
        assert.ok(lockedAt.getTime() >= started && lockedAt.getTime() <= Date.now(), lockedAt.toISOString());
      });
    });

    it('is refused with OBJECT_EXISTS when the object is created just before it takes the lock', async () => {
      const root = await newRoot();

      await beforeOpening(
        lockOf(root),
        () => createObject(root, ID, { 'a.txt': 'a' }),
        () => assert.rejects(root.create(ID, DETAILS, writeB), ocflError('OBJECT_EXISTS')),
      );

      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'a.txt': 'a' });
      assertNoWorkspace(root);
    });

    it('is told when the lock was created if its time has not been written into it yet', async () => {
      const { root, object } = await existingObject();
      const lock = lockOf(root);
      await fs.promises.mkdir(path.dirname(lock), { recursive: true });
      await fs.promises.writeFile(lock, '');
      const created = (await fs.promises.stat(lock)).mtime;

      const { code, lockedAt } = await rejection(object.update(DETAILS, writeB));

      assert.strictEqual(code, 'UPDATE_IN_PROGRESS');
      assert.deepStrictEqual(lockedAt, created);
    });

    it('is never let in by the age of the lock', async () => {
      const { root, object } = await existingObject();
      const lock = lockOf(root);
      const longAgo = new Date('2001-01-01T00:00:00.000Z');
      await fs.promises.mkdir(path.dirname(lock), { recursive: true });
      await fs.promises.writeFile(lock, longAgo.toISOString());
      await fs.promises.utimes(lock, longAgo, longAgo);

      const { code, lockedAt } = await rejection(object.update(DETAILS, writeB));

      assert.strictEqual(code, 'UPDATE_IN_PROGRESS');
      assert.deepStrictEqual(lockedAt, longAgo);
      assert.strictEqual(await fs.promises.readFile(lock, 'utf8'), longAgo.toISOString());
    });
  });

  describe('an out-of-date object', () => {
    it('is refused with OBJECT_OUT_OF_DATE before the callback runs, leaving no lock', async () => {
      const { root, stale, objectRoot } = await outOfDateObject();
      const before = await snapshot(objectRoot);
      let ran = false;

      await assert.rejects(
        stale.update(DETAILS, async (draft) => {
          ran = true;
          await writeC(draft);
        }),
        ocflError('OBJECT_OUT_OF_DATE'),
      );

      assert.strictEqual(ran, false);
      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assertNoWorkspace(root);
    });

    it('can be opened again and the update repeated', async () => {
      const { root, stale } = await outOfDateObject();
      await assert.rejects(stale.update(DETAILS, writeC), ocflError('OBJECT_OUT_OF_DATE'));

      const updated = await (await root.open(ID)).update(DETAILS, writeC);

      assert.strictEqual(updated.head.number, 3);
      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    });

    it('is refused with OBJECT_OUT_OF_DATE at commit when the head on disk moves while the update is staging', async () => {
      const { root, object, objectRoot } = await existingObject();
      let moved: Record<string, string> = {};

      await assert.rejects(
        object.update(DETAILS, async (draft) => {
          await writeB(draft);
          // As a writer that ignores the lock would leave it
          await rewriteInventory(objectRoot, (inventory) => {
            inventory.head = 'v2';
            inventory.versions = { ...inventory.versions, v2: inventory.versions!.v1! };
          });
          moved = await snapshot(objectRoot);
        }),
        ocflError('OBJECT_OUT_OF_DATE'),
      );

      assert.deepStrictEqual(await snapshot(objectRoot), moved);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
      assertNoWorkspace(root);

      const updated = await (await root.open(ID)).update(DETAILS, writeC);
      assert.strictEqual(updated.head.number, 3);
      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'c.txt': 'c' });
    });

    it('is refused with OBJECT_OUT_OF_DATE when its root inventory has gone', async () => {
      const { root, object, objectRoot } = await existingObject();
      await fs.promises.rm(path.join(objectRoot, 'inventory.json'));

      await assert.rejects(object.update(DETAILS, writeB), ocflError('OBJECT_OUT_OF_DATE'));

      assertNoWorkspace(root);
    });

    it('is refused with OBJECT_OUT_OF_DATE when its root inventory can no longer be read as one', async () => {
      const { root, object, objectRoot } = await existingObject();
      await fs.promises.writeFile(path.join(objectRoot, 'inventory.json'), '{ "head": ');

      await assert.rejects(object.update(DETAILS, writeB), ocflError('OBJECT_OUT_OF_DATE'));

      assertNoWorkspace(root);
    });
  });

  describe('the lock', () => {
    const endings: [string, (object: OcflObject) => Promise<unknown>][] = [
      ['a successful update', (object) => object.update(DETAILS, writeB)],
      [
        'a callback that throws',
        (object) =>
          assert.rejects(
            object.update(DETAILS, async (draft) => {
              await writeB(draft);
              throw new Error('callback failed');
            }),
            /callback failed/,
          ),
      ],
      ['an update that changes nothing', (object) => object.update(DETAILS, (draft) => draft.write('a.txt', 'a'))],
    ];

    for (const [name, end] of endings) {
      it(`is released after ${name}, so a later update succeeds`, async () => {
        const { root, object } = await existingObject();

        await end(object);

        assert.ok(!fs.existsSync(lockOf(root)));
        assertNoWorkspace(root);
        const updated = await (await root.open(ID)).update(DETAILS, writeC);
        assert.strictEqual((await textFiles(updated.head))['c.txt'], 'c');
      });
    }

    it("is one file in the object's workspace directory, whatever the version, held while the update runs", async () => {
      const { root, object } = await existingObject();
      const held: boolean[] = [];

      const second = await object.update(DETAILS, async (draft) => {
        held.push(fs.existsSync(lockOf(root)));
        await writeB(draft);
      });
      await second.update(DETAILS, async (draft) => {
        await writeC(draft);
        held.push(fs.existsSync(lockOf(root)));
      });

      assert.deepStrictEqual(held, [true, true]);
    });

    it('lets two different objects be updated at the same time', async () => {
      const root = await newRoot();
      const a = await createObject(root, 'a', { 'a.txt': 'a' });
      const b = await createObject(root, 'b', { 'a.txt': 'a' });

      const updatedA = await a.update(DETAILS, async (draft) => {
        await writeB(draft);
        const updatedB = await b.update(DETAILS, writeC);
        assert.strictEqual(updatedB.head.number, 2);
        assert.ok(fs.existsSync(lockOf(root, 'a')));
        await assert.rejects(
          root.create('c', DETAILS, async () => {
            throw new Error('callback failed');
          }),
          /callback failed/,
        );
        assert.ok(fs.existsSync(lockOf(root, 'a')));
      });

      assert.deepStrictEqual(await textFiles(updatedA.head), { 'a.txt': 'a', 'b.txt': 'b' });
      assert.deepStrictEqual(await textFiles((await root.open('b')).head), { 'a.txt': 'a', 'c.txt': 'c' });
      assertNoWorkspace(root);
    });

    it("is taken when another update's clean-up removes the empty workspace first", async () => {
      const root = await newRoot();

      const created = await beforeOpening(
        lockOf(root),
        () => fs.promises.rm(path.join(root.path, 'extensions'), { recursive: true }),
        () => root.create(ID, DETAILS, writeB),
      );

      assert.deepStrictEqual(await textFiles(created.head), { 'b.txt': 'b' });
      assertNoWorkspace(root);
    });

    it('reports any other failure to take it, leaving nothing behind', async () => {
      const root = await newRoot();

      await withFsFailure('open', lockOf(root), () => assert.rejects(root.create(ID, DETAILS, writeB), { code: 'EACCES' }), 'EACCES');

      assert.ok(!fs.existsSync(objectRootOf(root, ID)));
      assertNoWorkspace(root);
    });

    it('is not left behind when the time it was taken cannot be written into it', async () => {
      const root = await newRoot();
      const real = fs.promises.open;
      mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
        const handle = await real.apply(fs.promises, args);
        if (String(args[0]) === lockOf(root)) {
          handle.writeFile = async () => {
            throw fsError('ENOSPC');
          };
        }
        return handle;
      });

      await assert.rejects(root.create(ID, DETAILS, writeB), { code: 'ENOSPC' });

      assertNoWorkspace(root);
    });

    it('leaves no empty directories once released, and keeps unrelated workspace content', async () => {
      const { root, object } = await existingObject();
      const workspace = workspaceOf(root);
      await fs.promises.mkdir(workspace, { recursive: true });
      await fs.promises.writeFile(path.join(workspace, 'unrelated.txt'), 'keep');

      await object.update(DETAILS, writeB);

      assert.deepStrictEqual(await snapshot(workspace), { 'unrelated.txt': 'keep' });
      assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
    });
  });
});
