import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { OcflError, type OcflObject } from '../src/index.ts';
import {
  assertNoWorkspace,
  createObject,
  DETAILS,
  lockObject,
  lockOf,
  objectAtV1,
  objectRootOf,
  placesOf,
  recover,
  snapshot,
  textFiles,
  useTempRoots,
  workspaceOf,
  writeB,
  writeC,
} from './helpers/drafts.ts';
import { emptyDirectoriesUnder } from './helpers/empty-directories.ts';
import { beforeLinkingTo, beforeRenamingTo, withFsFailure } from './helpers/fs-failures.ts';
import { ocflError, rejection } from './helpers/ocfl-error.ts';
import { rewriteInventory, writeFiles } from './helpers/storage-roots.ts';

const ID = 'contended';

describe('concurrent writers', () => {
  const { newRoot } = useTempRoots('ocfl-concurrent-writers-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** A storage root holding the object {@link ID} at v1 */
  const existingObject = async () => objectAtV1(await newRoot(), ID);

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

    it('is refused when two updates start at the same moment, so only one of them commits', async () => {
      const { root, object } = await existingObject();

      const results = await Promise.allSettled([object.update(DETAILS, writeB), object.update(DETAILS, writeC)]);

      const refused = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      assert.strictEqual(refused.length, 1);
      assert.ok(ocflError('UPDATE_IN_PROGRESS')(refused[0]) || ocflError('OBJECT_OUT_OF_DATE')(refused[0]), String(refused[0]));
      assert.deepStrictEqual([...(await root.open(ID)).versions.keys()], [1, 2]);
      assertNoWorkspace(root);
    });

    it('is still refused when the first writer has removed the only file it wrote', async () => {
      const { object } = await existingObject();

      const returned = await object.update(DETAILS, async (draft) => {
        await draft.write('x/b.txt', 'b');
        await draft.remove('x/b.txt');
        await assert.rejects(object.update(DETAILS, writeC), ocflError('UPDATE_IN_PROGRESS'));
      });

      assert.strictEqual(returned, object);
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

      await beforeLinkingTo(
        lockOf(root, ID),
        () => createObject(root, ID, { 'a.txt': 'a' }),
        () => assert.rejects(root.create(ID, DETAILS, writeB), ocflError('OBJECT_EXISTS')),
      );

      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'a.txt': 'a' });
      assertNoWorkspace(root);
    });

    it('is refused, with no lockedAt, by a file at the lock that this library did not write', async () => {
      const { root, object } = await existingObject();
      const lock = lockOf(root, ID);
      await fs.promises.mkdir(path.dirname(lock), { recursive: true });
      await fs.promises.writeFile(lock, '');

      const error = await rejection(object.update(DETAILS, writeB), 'UPDATE_IN_PROGRESS');

      assert.ok(!('lockedAt' in error));
      assert.strictEqual(await fs.promises.readFile(lock, 'utf8'), '');
    });

    it('is never let in by the age of the lock', async () => {
      const { root, object } = await existingObject();
      const longAgo = new Date('2001-01-01T00:00:00.000Z');
      const lock = await lockObject(root, ID, longAgo);
      await fs.promises.utimes(lock, longAgo, longAgo);
      const content = await fs.promises.readFile(lock, 'utf8');

      const { code, lockedAt } = await rejection(object.update(DETAILS, writeB));

      assert.strictEqual(code, 'UPDATE_IN_PROGRESS');
      assert.deepStrictEqual(lockedAt, longAgo);
      assert.strictEqual(await fs.promises.readFile(lock, 'utf8'), content);
    });
  });

  describe('a create that has written its declaration and not yet its root inventory', () => {
    it('is not found by a reader, and refuses a second create with UPDATE_IN_PROGRESS, until it commits', async () => {
      const root = await newRoot();
      const { objectRoot } = placesOf(root, ID);
      const started = Date.now();

      const created = await beforeRenamingTo(
        path.join(objectRoot, 'inventory.json'),
        async () => {
          assert.ok(fs.existsSync(path.join(objectRoot, '0=ocfl_object_1.1')));
          await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
          const { lockedAt } = await rejection(root.create(ID, DETAILS, writeC), 'UPDATE_IN_PROGRESS');
          assert.ok(lockedAt instanceof Date);
          assert.ok(lockedAt.getTime() >= started && lockedAt.getTime() <= Date.now(), lockedAt.toISOString());
        },
        () => root.create(ID, DETAILS, writeB),
      );

      assert.deepStrictEqual(await textFiles(created.head), { 'b.txt': 'b' });
      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'b.txt': 'b' });
      assertNoWorkspace(root);
    });

    it('is reported the same way after its writer died there, until the object is recovered', async () => {
      const root = await newRoot();
      const { objectRoot, lock } = placesOf(root, ID);
      const inventory = path.join(objectRoot, 'inventory.json');
      await withFsFailure('rename', inventory, () =>
        withFsFailure('rm', `${inventory}.tmp`, () => assert.rejects(root.create(ID, DETAILS, writeB), ocflError('RECOVERY_NEEDED')), 'EACCES'),
      );

      await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
      await assert.rejects(root.create(ID, DETAILS, writeC), ocflError('UPDATE_IN_PROGRESS'));

      await fs.promises.rm(lock);
      await assert.rejects(root.open(ID), ocflError('INVALID_OBJECT', 'E063'));
      const { code, lockedAt } = await rejection(root.create(ID, DETAILS, writeC));
      assert.deepStrictEqual({ code, lockedAt }, { code: 'OBJECT_EXISTS', lockedAt: undefined });
    });

    it('costs a reader of a healthy object no look at the workspace', async () => {
      const { root } = await existingObject();
      const looked: string[] = [];
      for (const method of ['stat', 'readFile', 'readdir', 'open'] as const) {
        const real = fs.promises[method] as (...args: unknown[]) => Promise<unknown>;
        mock.method(fs.promises, method, (...args: unknown[]) => {
          looked.push(String(args[0]));
          return real.apply(fs.promises, args);
        });
      }

      await root.open(ID);

      assert.ok(looked.length > 0);
      assert.deepStrictEqual(
        looked.filter((file) => file.startsWith(workspaceOf(root))),
        [],
      );
    });
  });

  describe('a version left in the workspace with no lock', () => {
    /** {@link existingObject} with files in the workspace where its next version is assembled, as a dead writer whose lock was removed by hand leaves them */
    async function leftoverVersion() {
      const existing = await existingObject();
      await writeFiles(path.join(existing.workspace, 'v2'), { 'content/stale.txt': 'stale', 'stray.txt': 'stray' });
      return { ...existing, left: await snapshot(existing.root.path) };
    }

    it('refuses an update with RECOVERY_NEEDED before the callback runs, leaving everything as it was but the object locked', async () => {
      const { root, object, lock, left } = await leftoverVersion();
      let ran = false;

      const error = await rejection(
        object.update(DETAILS, async (draft) => {
          ran = true;
          await writeB(draft);
        }),
        'RECOVERY_NEEDED',
      );

      assert.match(error.message, /recover its unfinished write/);
      assert.strictEqual(ran, false);
      const { [path.relative(root.path, lock)]: held, ...rest } = await snapshot(root.path);
      assert.deepStrictEqual(rest, left);
      assert.strictEqual(JSON.parse(held ?? '{}').id, ID);
    });

    it('is never committed: once the object is recovered, an update holds only what its draft wrote', async () => {
      const { root, object, objectRoot } = await leftoverVersion();
      await assert.rejects(object.update(DETAILS, writeB), ocflError('RECOVERY_NEEDED'));

      await recover(root, ID);
      const updated = await (await root.open(ID)).update(DETAILS, writeB);

      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b' });
      assert.deepStrictEqual(Object.keys(await snapshot(path.join(objectRoot, 'v2'))).sort(), [
        path.join('content', 'b.txt'),
        'inventory.json',
        'inventory.json.sha512',
      ]);
      assertNoWorkspace(root);
    });

    it('refuses a create the same way', async () => {
      const root = await newRoot();
      const { workspace, objectRoot } = placesOf(root, ID);
      await writeFiles(path.join(workspace, 'v1'), { 'content/stale.txt': 'stale' });

      await assert.rejects(root.create(ID, DETAILS, writeB), ocflError('RECOVERY_NEEDED'));

      assert.ok(!fs.existsSync(objectRoot));
      await recover(root, ID);
      assert.deepStrictEqual(await textFiles((await root.create(ID, DETAILS, writeB)).head), { 'b.txt': 'b' });
    });

    it('reports any other failure to make the directory of the new version, and releases the lock', async () => {
      const { root, object, workspace, before, objectRoot } = await existingObject();

      await assert.rejects(
        withFsFailure('mkdir', path.join(workspace, 'v2'), () => object.update(DETAILS, writeB), 'EACCES'),
        { code: 'EACCES' },
      );

      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assertNoWorkspace(root);
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

        assert.ok(!fs.existsSync(lockOf(root, ID)));
        assertNoWorkspace(root);
        const updated = await (await root.open(ID)).update(DETAILS, writeC);
        assert.strictEqual((await textFiles(updated.head))['c.txt'], 'c');
      });
    }

    it("is one file in the object's workspace directory, whatever the version, held while the update runs", async () => {
      const { root, object } = await existingObject();
      const held: boolean[] = [];

      const second = await object.update(DETAILS, async (draft) => {
        held.push(fs.existsSync(lockOf(root, ID)));
        await writeB(draft);
      });
      await second.update(DETAILS, async (draft) => {
        await writeC(draft);
        held.push(fs.existsSync(lockOf(root, ID)));
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

      const created = await beforeLinkingTo(
        lockOf(root, ID),
        () => fs.promises.rm(path.join(root.path, 'extensions'), { recursive: true }),
        () => root.create(ID, DETAILS, writeB),
      );

      assert.deepStrictEqual(await textFiles(created.head), { 'b.txt': 'b' });
      assertNoWorkspace(root);
    });

    it('gives up, leaving nothing behind, when the workspace keeps vanishing', async () => {
      const root = await newRoot();

      await withFsFailure('link', lockOf(root, ID), () => assert.rejects(root.create(ID, DETAILS, writeB), { code: 'ENOENT' }), 'ENOENT');

      assert.ok(!fs.existsSync(objectRootOf(root, ID)));
      assertNoWorkspace(root);
    });

    it('reports any other failure to take it, leaving nothing behind', async () => {
      const root = await newRoot();

      await withFsFailure('link', lockOf(root, ID), () => assert.rejects(root.create(ID, DETAILS, writeB), { code: 'EACCES' }), 'EACCES');

      assert.ok(!fs.existsSync(objectRootOf(root, ID)));
      assertNoWorkspace(root);
    });

    it('is not left behind, nor anything of it, when its content cannot be written', async () => {
      const root = await newRoot();
      const staged = (target: string) => path.dirname(target) === path.dirname(lockOf(root, ID)) && path.basename(target).startsWith('.lock-');

      await withFsFailure('open', staged, () => assert.rejects(root.create(ID, DETAILS, writeB), { code: 'ENOSPC' }), 'ENOSPC');

      assertNoWorkspace(root);
    });

    it('is written whole: a writer refused meanwhile reads all of it', async () => {
      const root = await newRoot();
      const lock = lockOf(root, ID);
      let seen = '';

      await beforeLinkingTo(
        lock,
        async () => {
          seen = String(fs.existsSync(lock));
        },
        async () => {
          await root.create(ID, DETAILS, async (draft) => {
            seen += ` ${await fs.promises.readFile(lock, 'utf8')}`;
            await writeB(draft);
          });
        },
      );

      assert.match(seen, /^false \{"id":"[^"]+","lockedAt":"[^"]+","objectRootExisted":false\}$/);
    });

    it('is reported as held, with no lockedAt, when it cannot be read', async () => {
      const { root, object } = await existingObject();
      const lock = await lockObject(root, ID);

      const error = await withFsFailure('open', lock, () => rejection(object.update(DETAILS, writeB), 'UPDATE_IN_PROGRESS'), 'EACCES');

      assert.ok(!('lockedAt' in error));
      assert.ok(fs.existsSync(lock));
    });

    it('is not reported as held when a file is where its directory in the workspace would be', async () => {
      const { root, object } = await existingObject();
      const blocking = path.dirname(lockOf(root, ID));
      await fs.promises.mkdir(path.dirname(blocking), { recursive: true });
      await fs.promises.writeFile(blocking, 'not a directory');

      await assert.rejects(object.update(DETAILS, writeB), (error: NodeJS.ErrnoException) => !(error instanceof OcflError) && error.code === 'EEXIST');

      assert.strictEqual(await fs.promises.readFile(blocking, 'utf8'), 'not a directory');
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
