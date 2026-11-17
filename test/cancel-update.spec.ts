import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import {
  assertNoWorkspace,
  assertWritesNothing,
  createObject,
  DETAILS,
  objectRootOf,
  readInventory,
  textFiles,
  useTempRoots,
  writeB,
  writeC,
} from './helpers/drafts.ts';
import { beforeRenamingTo } from './helpers/fs-failures.ts';
import { writeFiles } from './helpers/storage-roots.ts';

/** Runs `fn`, calling `onRead` with the count so far each time a file is opened for reading */
async function countingReads<T>(onRead: (count: number) => void, fn: () => Promise<T>): Promise<{ reads: number; outcome: PromiseSettledResult<T> }> {
  let reads = 0;
  const real = fs.createReadStream;
  const spy = mock.method(fs, 'createReadStream', (...args: Parameters<typeof real>) => {
    onRead(++reads);
    return real.apply(fs, args);
  });
  try {
    const [outcome] = await Promise.allSettled([fn()]);
    return { reads, outcome: outcome as PromiseSettledResult<T> };
  } finally {
    spy.mock.restore();
  }
}

describe('cancelling a create or an update', () => {
  const temp = useTempRoots('ocfl-cancel-');

  it('rejects an update with the reason of a signal already aborted, before taking the lock or calling back', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'pre-aborted', { 'a.txt': 'a' });
    const reason = new Error('never started');
    let called = false;
    await assertWritesNothing(root, object, () =>
      assert.rejects(
        object.update({ ...DETAILS, signal: AbortSignal.abort(reason) }, async (draft) => {
          called = true;
          await writeB(draft);
        }),
        (error) => error === reason,
      ),
    );
    assert.strictEqual(called, false);
  });

  it('ignores a signal the options only inherit', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'inherited', { 'a.txt': 'a' });
    const options = Object.assign(Object.create({ signal: AbortSignal.abort(new Error('inherited')) }), DETAILS);
    const updated = await object.update(options, writeB);
    assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b' });
  });

  it('rejects a create with the reason of a signal already aborted, leaving no object root', async () => {
    const root = await temp.newRoot();
    const reason = new Error('never created');
    await assert.rejects(root.create('pre-aborted', { ...DETAILS, signal: AbortSignal.abort(reason) }, writeB), (error) => error === reason);
    assert.ok(!fs.existsSync(objectRootOf(root, 'pre-aborted')));
    assertNoWorkspace(root);
  });

  it('stops an import part way when aborted, and discards the update, leaving the object unlocked', async () => {
    const root = await temp.newRoot();
    const source = path.join(temp.dir, 'many');
    await writeFiles(source, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}.txt`, `file ${i}`])));
    const object = await createObject(root, 'importing', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('request closed');
    const { reads, outcome } = await countingReads(
      (count) => {
        if (count === 5) {
          controller.abort(reason);
        }
      },
      () => object.update({ ...DETAILS, signal: controller.signal }, (draft) => draft.import(source)),
    );
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.ok(reads < 100, `read ${reads} of 100 files`);
    const reopened = await root.open('importing');
    assert.strictEqual(reopened.head.number, 1);
    assert.strictEqual(await root.unfinishedWrite('importing'), undefined);
    assertNoWorkspace(root);
    await reopened.update(DETAILS, writeB);
  });

  it('stops copying imported files when aborted once they have all been read', async () => {
    const root = await temp.newRoot();
    const source = path.join(temp.dir, 'copied');
    await writeFiles(source, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, `copied ${i}`])));
    const object = await createObject(root, 'copying', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop copying');
    let copies = 0;
    const real = fs.promises.copyFile;
    const spy = mock.method(fs.promises, 'copyFile', (...args: Parameters<typeof real>) => {
      if (String(args[0]).startsWith(source) && ++copies === 1) {
        controller.abort(reason);
      }
      return real.apply(fs.promises, args);
    });
    try {
      await assert.rejects(
        object.update({ ...DETAILS, signal: controller.signal }, (draft) => draft.import(source)),
        (error) => error === reason,
      );
    } finally {
      spy.mock.restore();
    }
    assert.ok(copies < 30, `copied ${copies} of 30 files`);
    assert.strictEqual((await root.open('copying')).head.number, 1);
    assertNoWorkspace(root);
  });

  it('rejects every draft operation started after the abort with its reason', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'later-ops', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop');
    const rejections: unknown[] = [];
    await assert.rejects(
      object.update({ ...DETAILS, signal: controller.signal }, async (draft) => {
        await writeB(draft);
        controller.abort(reason);
        for (const operation of [
          () => draft.write('c.txt', 'c'),
          () => draft.import(temp.dir),
          () => draft.copy('a.txt', 'd.txt'),
          () => draft.rename('a.txt', 'e.txt'),
          () => draft.reinstate('a.txt', 1),
          () => draft.remove('a.txt'),
          () => draft.clear(),
          () => draft.files(),
        ]) {
          await operation().catch((error: unknown) => rejections.push(error));
        }
      }),
      (error) => error === reason,
    );
    assert.deepStrictEqual(rejections, Array(8).fill(reason));
    assert.deepStrictEqual(await textFiles((await root.open('later-ops')).head), { 'a.txt': 'a' });
  });

  it('discards the update and rejects with the reason even when the callback catches the error and returns', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'caught', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop');
    await assertWritesNothing(root, object, () =>
      assert.rejects(
        object.update({ ...DETAILS, signal: controller.signal }, async (draft) => {
          controller.abort(reason);
          await draft.write('b.txt', 'b').catch(() => {});
        }),
        (error) => error === reason,
      ),
    );
  });

  it('rejects with the reason, not the error the callback throws, once the signal is aborted', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'thrown', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop');
    await assert.rejects(
      object.update({ ...DETAILS, signal: controller.signal }, async () => {
        controller.abort(reason);
        throw new Error('the callback failed');
      }),
      (error) => error === reason,
    );
  });

  it('checks the signal once more as the callback returns, discarding work that was done before the abort', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'at-return', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop');
    await assertWritesNothing(root, object, () =>
      assert.rejects(
        object.update({ ...DETAILS, signal: controller.signal }, async (draft) => {
          await writeB(draft);
          controller.abort(reason);
        }),
        (error) => error === reason,
      ),
    );
  });

  it('ignores an abort after the commit point, and the new version is there', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'committed', { 'a.txt': 'a' });
    const controller = new AbortController();
    const sidecar = path.join(objectRootOf(root, 'committed'), 'inventory.json.sha512');
    const updated = await beforeRenamingTo(
      sidecar,
      async () => controller.abort(new Error('too late')),
      () => object.update({ ...DETAILS, signal: controller.signal }, writeB),
    );
    assert.ok(controller.signal.aborted);
    assert.strictEqual(updated.head.number, 2);
    assert.deepStrictEqual(await textFiles((await root.open('committed')).head), { 'a.txt': 'a', 'b.txt': 'b' });
  });

  it('commits as usual with a signal that is never aborted, and records nothing of it', async () => {
    const root = await temp.newRoot();
    const created = await root.create('unaborted', { ...DETAILS, signal: new AbortController().signal }, writeB);
    const updated = await created.update({ ...DETAILS, signal: new AbortController().signal }, writeC);
    assert.deepStrictEqual(await textFiles(updated.head), { 'b.txt': 'b', 'c.txt': 'c' });
    const inventory = await readInventory(objectRootOf(root, 'unaborted'));
    for (const version of ['v1', 'v2']) {
      const { created: _, state: __, ...recorded } = inventory.versions[version]!;
      assert.deepStrictEqual(recorded, DETAILS);
    }
  });

  it('rejects with the reason of a signal already aborted before looking for the object', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'exists', { 'a.txt': 'a' });
    const reason = new Error('never started');
    await assert.rejects(root.create('exists', { ...DETAILS, signal: AbortSignal.abort(reason) }, writeB), (error) => error === reason);
    await root.purge('exists');
    await assert.rejects(object.update({ ...DETAILS, signal: AbortSignal.abort(reason) }, writeB), (error) => error === reason);
  });

  it('waits for a streamed write to finish staging before discarding, so nothing is left in the workspace', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'streaming', { 'a.txt': 'a' });
    const controller = new AbortController();
    const reason = new Error('stop mid-stream');
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    async function* slow() {
      yield 'first part, ';
      await released;
      yield 'second part';
      finished = true;
    }
    await assert.rejects(
      object.update({ ...DETAILS, signal: controller.signal }, async (draft) => {
        const write = draft.write('streamed.txt', slow());
        controller.abort(reason);
        setTimeout(release, 20);
        await write.catch(() => {});
      }),
      (error) => error === reason,
    );
    assert.ok(finished, 'the update rejected while the write was still staging content');
    assertNoWorkspace(root);
    assert.strictEqual((await (await root.open('streaming')).update(DETAILS, writeB)).head.number, 2);
  });

  it("rejects with the callback's own error when the signal is aborted only while the update is being discarded", async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'late-abort', { 'a.txt': 'a' });
    const controller = new AbortController();
    const failure = new Error('the callback failed first');
    await assert.rejects(
      object.update({ ...DETAILS, signal: controller.signal }, async (draft) => {
        await writeB(draft);
        setImmediate(() => controller.abort(new Error('too late')));
        throw failure;
      }),
      (error) => error === failure,
    );
  });
});
