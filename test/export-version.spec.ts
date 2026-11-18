import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { ExportProgress } from '../src/index.ts';
import { createObject, DETAILS, everything, manyFiles, objectRootOf, snapshot, useTempRoots } from './helpers/drafts.ts';
import { fsError } from './helpers/fs-failures.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { isClosed, trackReadHandles } from './helpers/read-handles.ts';

/** Passes each file handle opened to write a new file through `then` */
function onOpeningToWrite(t: TestContext, then: (handle: fs.promises.FileHandle) => fs.promises.FileHandle): void {
  const real = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
    const handle = await real.apply(fs.promises, args);
    return args[1] === 'wx' ? then(handle) : handle;
  });
}

describe('writing a version out to a directory', () => {
  const temp = useTempRoots('ocfl-export-');

  it('writes each file of the version under its logical path into a missing directory, and nothing else', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a', 'notes/day/1.txt': 'one', 'notes/2.txt': 'two' });
    const target = path.join(temp.dir, 'out-missing', 'item');
    await object.head.exportTo(target);
    assert.deepStrictEqual(await everything(target), {
      paths: ['a.txt', 'notes', 'notes/2.txt', 'notes/day', 'notes/day/1.txt'],
      files: { 'a.txt': 'a', 'notes/2.txt': 'two', 'notes/day/1.txt': 'one' },
    });
  });

  it('writes an older version as it was, not the head', async () => {
    const root = await temp.newRoot();
    const v1 = await createObject(root, 'item', { 'a.txt': 'a', 'b.txt': 'b' });
    const v2 = await v1.update(DETAILS, async (draft) => {
      await draft.remove('b.txt');
      await draft.write('a.txt', 'a changed');
    });
    const target = path.join(temp.dir, 'out-old');
    await v2.versions.get(1)?.exportTo(target);
    assert.deepStrictEqual(await snapshot(target), { 'a.txt': 'a', 'b.txt': 'b' });
  });

  it('writes into an existing empty directory', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    const target = path.join(temp.dir, 'out-empty');
    await fs.promises.mkdir(target);
    await object.head.exportTo(target);
    assert.deepStrictEqual(await snapshot(target), { 'a.txt': 'a' });
  });

  it('refuses a directory with anything in it, leaving it as it was', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a', 'b.txt': 'b' });
    const target = path.join(temp.dir, 'out-full');
    await fs.promises.mkdir(path.join(target, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(target, 'a.txt'), 'mine');
    await assert.rejects(object.head.exportTo(target), ocflError('DIRECTORY_NOT_EMPTY'));
    assert.deepStrictEqual(await everything(target), { paths: ['a.txt', 'sub'], files: { 'a.txt': 'mine' } });
  });

  it("sets each file's modification and access times to the time of the version it was modified in", async () => {
    const root = await temp.newRoot();
    const v1Time = new Date('2024-01-02T03:04:05.000Z');
    const v2Time = new Date('2024-06-07T08:09:10.000Z');
    const v3Time = new Date('2025-11-12T13:14:15.000Z');
    const v1 = await root.create('item', { ...DETAILS, createdAt: v1Time }, async (draft) => {
      await draft.write('same.txt', 'same');
      await draft.write('changed.txt', 'before');
    });
    const v2 = await v1.update({ ...DETAILS, createdAt: v2Time }, (draft) => draft.write('changed.txt', 'after'));
    const v3 = await v2.update({ ...DETAILS, createdAt: v3Time }, (draft) => draft.write('added.txt', 'new'));
    const target = path.join(temp.dir, 'out-times');
    await v3.head.exportTo(target);
    const times = async (name: string) => {
      const { mtimeMs, atimeMs } = await fs.promises.stat(path.join(target, name));
      return [mtimeMs, atimeMs];
    };
    assert.deepStrictEqual(await times('same.txt'), [v1Time.getTime(), v1Time.getTime()]);
    assert.deepStrictEqual(await times('changed.txt'), [v2Time.getTime(), v2Time.getTime()]);
    assert.deepStrictEqual(await times('added.txt'), [v3Time.getTime(), v3Time.getTime()]);
  });

  it('reports progress once per file, ending with every file written', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', manyFiles(12));
    const target = path.join(temp.dir, 'out-progress');
    const seen: { progress: ExportProgress; written: number }[] = [];
    await object.head.exportTo(target, {
      onProgress: (progress) => {
        seen.push({ progress: { ...progress }, written: fs.readdirSync(target).length });
      },
    });
    assert.deepStrictEqual(
      seen,
      Array.from({ length: 12 }, (_, i) => ({ progress: { exportedFiles: i + 1, totalFiles: 12 }, written: i + 1 })),
    );
  });

  it('rejects with the reason of a signal already aborted, making no directory and reading no stored file', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', manyFiles(3));
    const target = path.join(temp.dir, 'out-pre-aborted');
    const reason = new Error('stop before starting');
    const { handles, outcome } = await trackReadHandles(() => object.head.exportTo(target, { signal: AbortSignal.abort(reason) }));
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.strictEqual(handles.length, 0);
    assert.strictEqual(fs.existsSync(target), false);
  });

  it('stops between files when the signal is aborted, rejecting with its reason and leaving what it wrote', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', manyFiles(30));
    const target = path.join(temp.dir, 'out-aborted');
    const controller = new AbortController();
    const reason = new Error('stop part way');
    const { handles, outcome } = await trackReadHandles(() =>
      object.head.exportTo(target, {
        signal: controller.signal,
        onProgress: ({ exportedFiles }) => {
          if (exportedFiles === 5) {
            controller.abort(reason);
          }
        },
      }),
    );
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.strictEqual(handles.length, 5);
    assert.ok(handles.every(isClosed));
    assert.strictEqual(fs.readdirSync(target).length, 5);
  });

  it('stops part way through a file when the signal is aborted, rejecting with its reason and leaving no stored file open', async (t) => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', manyFiles(3));
    const target = path.join(temp.dir, 'out-aborted-in-file');
    const controller = new AbortController();
    const reason = new Error('stop mid-file');
    onOpeningToWrite(t, (handle) => {
      const writeFile = handle.writeFile.bind(handle);
      return Object.assign(handle, {
        writeFile: (...args: Parameters<typeof writeFile>) => {
          const writing = writeFile(...args);
          controller.abort(reason);
          return writing;
        },
      });
    });
    const { handles, outcome } = await trackReadHandles(() => object.head.exportTo(target, { signal: controller.signal }));
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.strictEqual(handles.length, 1);
    assert.ok(handles.every(isClosed));
  });

  it('stops and rejects with the error onProgress throws', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', manyFiles(10));
    const target = path.join(temp.dir, 'out-progress-throws');
    const thrown = new Error('progress bar broke');
    let calls = 0;
    await assert.rejects(
      object.head.exportTo(target, {
        onProgress: ({ exportedFiles }) => {
          calls++;
          if (exportedFiles === 3) {
            throw thrown;
          }
        },
      }),
      (error) => error === thrown,
    );
    assert.strictEqual(calls, 3);
    assert.strictEqual(fs.readdirSync(target).length, 3);
  });

  it('refuses a directory inside the storage root with a TypeError, making nothing', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    const before = await everything(root.path);
    for (const dir of [root.path, path.join(root.path, 'exports', 'item'), path.join(objectRootOf(root, 'item'), 'out')]) {
      await assert.rejects(object.head.exportTo(dir), TypeError);
    }
    assert.deepStrictEqual(await everything(root.path), before);
  });

  it('resolves a relative directory against the working directory', async (t) => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    const cwd = process.cwd();
    process.chdir(temp.dir);
    t.after(() => process.chdir(cwd));
    await object.head.exportTo('out-relative/item');
    assert.deepStrictEqual(await snapshot(path.join(temp.dir, 'out-relative', 'item')), { 'a.txt': 'a' });
  });

  it('refuses a missing, empty or non-string directory with a TypeError', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    for (const dir of [undefined, '', 42]) {
      await assert.rejects(object.head.exportTo(dir as never), TypeError);
    }
  });

  it('refuses bad options with a TypeError, making no directory', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    const target = path.join(temp.dir, 'out-bad-options');
    for (const options of ['fast', { overwrite: true }, { signal: 'stop' }, { onProgress: 'log' }]) {
      await assert.rejects(object.head.exportTo(target, options as never), TypeError);
    }
    assert.strictEqual(fs.existsSync(target), false);
  });

  it('refuses a version whose stored file is missing with INVALID_OBJECT', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a', 'b.txt': 'b' });
    await fs.promises.rm(path.join(objectRootOf(root, 'item'), 'v1/content/b.txt'));
    const target = path.join(temp.dir, 'out-missing-stored');
    const { handles, outcome } = await trackReadHandles(() => object.head.exportTo(target));
    assert.strictEqual(outcome.status, 'rejected');
    assert.ok(ocflError('INVALID_OBJECT')(outcome.reason), String(outcome.reason));
    assert.ok(handles.every(isClosed));
  });

  it('passes a file system error writing a file through, leaving no stored file open', async (t) => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'item', { 'a.txt': 'a' });
    const target = path.join(temp.dir, 'out-write-fails');
    onOpeningToWrite(t, (handle) => Object.assign(handle, { writeFile: () => Promise.reject(fsError('EIO')) }));
    const { handles, outcome } = await trackReadHandles(() => object.head.exportTo(target));
    assert.strictEqual(outcome.status, 'rejected');
    assert.strictEqual((outcome.reason as NodeJS.ErrnoException).code, 'EIO');
    assert.strictEqual(handles.length, 1);
    assert.ok(handles.every(isClosed));
  });
});
