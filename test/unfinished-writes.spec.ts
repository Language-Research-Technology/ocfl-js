import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { Draft, OcflObject, StorageRoot, UnfinishedWrite } from '../src/index.ts';
import { openStorageRoot } from '../src/index.ts';
import { createObject, DETAILS, lockObject, placesOf, recover, snapshot, useTempRoots, workspaceOf, writeB } from './helpers/drafts.ts';
import { withFsFailure } from './helpers/fs-failures.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import { ocflError, rejection } from './helpers/ocfl-error.ts';

const ID = 'arcp://name,corpus/item/1';

/** Every unfinished write the storage root lists */
async function listed(root: StorageRoot): Promise<UnfinishedWrite[]> {
  const writes: UnfinishedWrite[] = [];
  for await (const write of root.unfinishedWrites()) {
    writes.push(write);
  }
  return writes;
}

/** Runs `write`, whose callback calls `hold`, and holds it there until `finish` is called */
function held<T>(write: (hold: () => Promise<void>) => Promise<T>) {
  let release = () => {};
  let started = () => {};
  const inside = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = write(async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return {
    inside,
    finish: async () => {
      release();
      return done;
    },
  };
}

function heldCreate(root: StorageRoot, id: string) {
  return held((hold) =>
    root.create(id, DETAILS, async (draft: Draft) => {
      await draft.write('a.txt', 'a');
      await hold();
    }),
  );
}

function heldUpdate(object: OcflObject, change: (draft: Draft) => Promise<void> = writeB) {
  return held((hold) =>
    object.update(DETAILS, async (draft: Draft) => {
      await change(draft);
      await hold();
    }),
  );
}

describe('root.unfinishedWrites', () => {
  const roots = useTempRoots('ocfl-unfinished-');
  const { newRoot } = roots;
  let crashes = 0;
  afterEach(() => {
    mock.restoreAll();
  });

  /** The storage root as a host that crashed now would leave it: a copy of it, opened */
  async function crashed(root: StorageRoot): Promise<StorageRoot> {
    const copy = path.join(roots.dir, `crashed-${crashes++}`);
    await fs.promises.cp(root.path, copy, { recursive: true });
    return openStorageRoot(copy);
  }

  it('lists a create in progress on a hashed root with its id and when its lock was taken', async () => {
    const root = await newRoot({ extensionName: HASHED });
    const before = new Date();
    const create = heldCreate(root, ID);
    await create.inside;
    const after = new Date();

    const writes = await listed(root);

    assert.strictEqual(writes.length, 1);
    const [write] = writes;
    assert.strictEqual(write?.id, ID);
    assert.strictEqual(write?.removing, false);
    assert.ok(write.lockedAt >= before && write.lockedAt <= after, `${write.lockedAt.toISOString()} is not while the create ran`);
    await create.finish();
    assert.deepStrictEqual(await listed(root), []);
  });

  it('lists nothing, and changes nothing, in a storage root with no locks', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    const before = await snapshot(root.path);

    assert.deepStrictEqual(await listed(root), []);

    assert.deepStrictEqual(await snapshot(root.path), before);
  });

  it('recovers a create that died in its build on a hashed root, so the id can be created again', async () => {
    const live = await newRoot({ extensionName: HASHED });
    const create = heldCreate(live, ID);
    await create.inside;
    const root = await crashed(live);
    await create.finish();
    const before = await snapshot(root.path);

    const [write, ...others] = await listed(root);
    assert.deepStrictEqual(others, []);
    assert.strictEqual(write?.id, ID);
    await write.recover();

    assert.ok(!fs.existsSync(workspaceOf(root)));
    const remaining = Object.keys(before).filter((file) => fs.existsSync(path.join(root.path, file)));
    assert.deepStrictEqual(Object.keys(await snapshot(root.path)).sort(), remaining.sort());
    assert.strictEqual((await fs.promises.readdir(root.path)).filter((name) => /^[0-9a-f]{3}$/.test(name)).length, 0);
    const created = await root.create(ID, DETAILS, writeB);
    assert.strictEqual(created.head.number, 1);
  });

  it('lists an update that died, and recovering it leaves the object at its head and updatable', async () => {
    const live = await newRoot();
    const object = await createObject(live, 'a', { 'a.txt': 'a' });
    const update = heldUpdate(object);
    await update.inside;
    const root = await crashed(live);
    await update.finish();

    const [write] = await listed(root);
    assert.deepStrictEqual([write?.id, write?.removing], ['a', false]);
    await write?.recover();

    assert.deepStrictEqual(await listed(root), []);
    const reopened = await root.open('a');
    assert.strictEqual(reopened.head.number, 1);
    assert.strictEqual((await reopened.update(DETAILS, writeB)).head.number, 2);
  });

  it('lists a remove that died part of the way through as removing, and recovering it finishes the remove', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await withFsFailure('rm', path.join(placesOf(root, 'a').objectRoot, 'v1'), () => assert.rejects(root.remove('a'), ocflError('RECOVERY_NEEDED')));

    const [write] = await listed(root);
    assert.deepStrictEqual([write?.id, write?.removing], ['a', true]);
    await write?.recover();

    await assert.rejects(root.open('a'), ocflError('OBJECT_NOT_FOUND'));
    assert.deepStrictEqual(await listed(root), []);
  });

  it('records an id with a newline, quotes and non-ASCII characters exactly', async () => {
    const root = await newRoot({ extensionName: HASHED });
    const id = 'urn:x:"line one"\nline two – ñ ✓ 🦘';
    const create = heldCreate(root, id);
    await create.inside;

    const [write] = await listed(root);
    assert.strictEqual(write?.id, id);
    assert.strictEqual((await root.unfinishedWrite(id))?.id, id);
    await create.finish();
  });

  it("doesn't list a file named lock in an unfinished version, even one holding a copy of the object's lock", async () => {
    const root = await newRoot();
    const object = await createObject(root, 'a', { 'a.txt': 'a' });
    const { lock } = placesOf(root, 'a');
    const update = heldUpdate(object, async (draft) => draft.write('lock', await fs.promises.readFile(lock, 'utf8')));
    await update.inside;

    const writes = await listed(root);

    assert.deepStrictEqual(
      writes.map((write) => write.id),
      ['a'],
    );
    await update.finish();
  });

  const lockedAt = '2026-11-10T22:01:44.000Z';
  it("lists a lock with a field it doesn't know, as a later release may write, and recovers it", async () => {
    const root = await newRoot();
    const { lock } = placesOf(root, 'a');
    await fs.promises.mkdir(path.dirname(lock), { recursive: true });
    await fs.promises.writeFile(lock, JSON.stringify({ id: 'a', lockedAt, objectRootExisted: false, owner: 'x' }));

    const writes = await listed(root);
    assert.deepStrictEqual(
      writes.map((write) => [write.id, write.lockedAt.toISOString()]),
      [['a', lockedAt]],
    );
    await (await root.unfinishedWrite('a'))?.recover();

    assert.deepStrictEqual(await listed(root), []);
    assert.strictEqual(await root.unfinishedWrite('a'), undefined);
  });

  for (const [what, content] of [
    ['removing false', { id: 'a', lockedAt, objectRootExisted: true, removing: false }],
    ['a time that is not ISO 8601', { id: 'a', lockedAt: 'Tue, 10 Nov 2026 22:01:44 GMT', objectRootExisted: true }],
    ['an invalid time', { id: 'a', lockedAt: 'never', objectRootExisted: true }],
    ['an empty id', { id: '', lockedAt, objectRootExisted: true }],
  ] as const) {
    it(`doesn't list a file at a lock with ${what}, which this library didn't write`, async () => {
      const root = await newRoot();
      const { lock } = placesOf(root, 'a');
      await fs.promises.mkdir(path.dirname(lock), { recursive: true });
      await fs.promises.writeFile(lock, JSON.stringify(content));

      assert.deepStrictEqual(await listed(root), []);
      assert.strictEqual(await root.unfinishedWrite('a'), undefined);
    });
  }

  it("doesn't list a directory named lock, nor a lock whose id the layout can't place", async () => {
    const root = await newRoot();
    await fs.promises.mkdir(placesOf(root, 'a').lock, { recursive: true });
    await lockObject(root, 'extensions', new Date(lockedAt), 'b');

    assert.deepStrictEqual(await listed(root), []);
    assert.strictEqual(await root.unfinishedWrite('a'), undefined);
  });

  describe('a lock taken but not yet put in place', () => {
    it("isn't listed, and doesn't stop the next writer", async () => {
      const root = await newRoot();
      const { workspace } = placesOf(root, 'a');
      await fs.promises.mkdir(workspace, { recursive: true });
      await fs.promises.writeFile(path.join(workspace, '.lock-0'), JSON.stringify({ id: 'a', lockedAt: new Date().toISOString(), objectRootExisted: false }));

      assert.deepStrictEqual(await listed(root), []);
      assert.strictEqual(await root.unfinishedWrite('a'), undefined);
      assert.strictEqual((await root.create('a', DETAILS, writeB)).head.number, 1);
    });

    it('is cleared by recovering the next writer that died', async () => {
      const root = await newRoot();
      await createObject(root, 'a', { 'a.txt': 'a' });
      const { workspace } = placesOf(root, 'a');
      await lockObject(root, 'a');
      await fs.promises.writeFile(path.join(workspace, '.lock-0'), '{}');

      await recover(root, 'a');

      assert.ok(!fs.existsSync(workspaceOf(root)));
    });
  });

  it('lets exactly one of two writers racing for a lock take it', async () => {
    const root = await newRoot();
    const results = await Promise.allSettled([root.create('a', DETAILS, writeB), root.create('a', DETAILS, writeB)]);

    assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
    const [refused] = results.filter((result) => result.status === 'rejected');
    assert.ok(ocflError('UPDATE_IN_PROGRESS')(refused?.reason), String(refused?.reason));
  });
});

describe('root.unfinishedWrite', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-one-');

  it('is the write of a locked object, and undefined for an unlocked one', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await createObject(root, 'b', { 'b.txt': 'b' });
    const lockedAt = new Date('2026-11-10T22:01:44.000Z');
    await lockObject(root, 'a', lockedAt);

    const write = await root.unfinishedWrite('a');

    assert.deepStrictEqual([write?.id, write?.lockedAt, write?.removing], ['a', lockedAt, false]);
    assert.strictEqual(await root.unfinishedWrite('b'), undefined);
    assert.strictEqual(await root.unfinishedWrite('never-created'), undefined);
  });

  it('throws a TypeError for a missing id', async () => {
    const root = await newRoot();

    await assert.rejects(root.unfinishedWrite(''), TypeError);
  });
});

describe('write.recover', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-recover-');

  it('throws UPDATE_IN_PROGRESS, changing nothing, if another writer has taken the lock since it was listed', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'a', { 'a.txt': 'a' });
    await lockObject(root, 'a', new Date('2026-11-10T22:01:44.000Z'));
    const [write] = await listed(root);
    await fs.promises.rm(placesOf(root, 'a').lock);
    const update = heldUpdate(object);
    await update.inside;
    const before = await snapshot(root.path);

    const error = await rejection(write?.recover() ?? Promise.resolve(), 'UPDATE_IN_PROGRESS');

    assert.strictEqual(error.lockedAt?.getTime(), (await root.unfinishedWrite('a'))?.lockedAt.getTime());
    assert.deepStrictEqual(await snapshot(root.path), before);
    assert.strictEqual((await update.finish()).head.number, 2);
  });

  it('does nothing if the lock has been released since it was listed', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await lockObject(root, 'a');
    const [write] = await listed(root);
    await fs.promises.rm(placesOf(root, 'a').lock);
    const before = await snapshot(root.path);

    assert.strictEqual(await write?.recover(), undefined);

    assert.deepStrictEqual(await snapshot(root.path), before);
  });

  it('finishes a remove listed before it began deleting, as the same writer', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    const lock = await lockObject(root, 'a', new Date('2026-11-10T22:01:44.000Z'));
    const [write] = await listed(root);
    await fs.promises.writeFile(lock, JSON.stringify({ ...JSON.parse(await fs.promises.readFile(lock, 'utf8')), removing: true }));

    await write?.recover();

    await assert.rejects(root.open('a'), ocflError('OBJECT_NOT_FOUND'));
    assert.ok(!fs.existsSync(workspaceOf(root)));
  });

  it('is unaffected by the caller changing the lockedAt it was given', async () => {
    const root = await newRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await lockObject(root, 'a');
    const [write] = await listed(root);

    write?.lockedAt.setFullYear(2001);
    await write?.recover();

    assert.ok(!fs.existsSync(workspaceOf(root)));
  });
});

describe('reading and writing a lock', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-lock-io-');
  afterEach(() => {
    mock.restoreAll();
  });

  /** Makes `method` of every file handle opened on a path that `matches` fail with `code` */
  function failHandle(method: 'read' | 'writeFile', matches: (file: string) => boolean, code: string) {
    const real = fs.promises.open;
    mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
      const handle = await real.apply(fs.promises, args);
      if (matches(String(args[0]))) {
        handle[method] = async () => {
          throw Object.assign(new Error('injected failure'), { code });
        };
      }
      return handle;
    });
  }

  it("doesn't list a file named lock too large to be one", async () => {
    const root = await newRoot();
    const { lock } = placesOf(root, 'a');
    await fs.promises.mkdir(path.dirname(lock), { recursive: true });
    await fs.promises.writeFile(lock, ' '.repeat(64 * 1024 + 1));

    assert.deepStrictEqual(await listed(root), []);
  });

  it('throws the file system error that stops a lock being read', async () => {
    const root = await newRoot();
    const lock = await lockObject(root, 'a');
    failHandle('read', (file) => file === lock, 'EIO');

    await assert.rejects(listed(root), { code: 'EIO' });
  });

  it('leaves nothing of a lock whose content fails part of the way through being written', async () => {
    const root = await newRoot();
    failHandle('writeFile', (file) => path.basename(file).startsWith('.lock-'), 'ENOSPC');

    await assert.rejects(root.create('a', DETAILS, writeB), { code: 'ENOSPC' });

    assert.ok(!fs.existsSync(workspaceOf(root)));
  });
});

describe('a storage root on a file system without hard links', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-no-links-');

  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    it(`refuses a create, update or remove with UNSUPPORTED_FILESYSTEM when linking fails with ${code}, and changes nothing`, async () => {
      const root = await newRoot();
      const object = await createObject(root, 'a', { 'a.txt': 'a' });
      const before = await snapshot(root.path);

      const writes: (() => Promise<unknown>)[] = [() => root.create('b', DETAILS, writeB), () => object.update(DETAILS, writeB), () => root.remove('a')];
      for (const write of writes) {
        await assert.rejects(
          withFsFailure('link', () => true, write, code),
          ocflError('UNSUPPORTED_FILESYSTEM'),
        );
        assert.deepStrictEqual(await snapshot(root.path), before);
      }
      assert.deepStrictEqual(await listed(root), []);
    });
  }
});

describe('with a layout whose object paths are deep', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-path-direct-');

  it("doesn't list a copy of a lock in a version left in the workspace with no lock", async () => {
    const root = await newRoot({ extensionName: PATH_DIRECT });
    await createObject(root, 'corpus/item', { 'a.txt': 'a' });
    const copy = JSON.stringify({ id: 'corpus/item', lockedAt: new Date().toISOString(), objectRootExisted: true });
    await fs.promises.mkdir(path.join(workspaceOf(root), 'corpus', 'item', '__object__', 'v2', 'content'), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceOf(root), 'corpus', 'item', '__object__', 'v2', 'content', 'lock'), copy);

    assert.deepStrictEqual(await listed(root), []);
    assert.strictEqual(await root.unfinishedWrite('corpus/item'), undefined);
  });
});

describe('an update that finds an unfinished version in the workspace', () => {
  const { newRoot } = useTempRoots('ocfl-unfinished-leftover-');

  it('keeps its lock and throws RECOVERY_NEEDED, and recovering its write clears the version and the lock', async () => {
    const root = await newRoot();
    const object = await createObject(root, 'a', { 'a.txt': 'a' });
    const leftover = path.join(placesOf(root, 'a').workspace, 'v2', 'content', 'b.txt');
    await fs.promises.mkdir(path.dirname(leftover), { recursive: true });
    await fs.promises.writeFile(leftover, 'b');

    await assert.rejects(object.update(DETAILS, writeB), ocflError('RECOVERY_NEEDED'));

    const [write] = await listed(root);
    assert.strictEqual(write?.id, 'a');
    await write?.recover();
    assert.ok(!fs.existsSync(workspaceOf(root)));
    assert.strictEqual((await (await root.open('a')).update(DETAILS, writeB)).head.number, 2);
  });
});
