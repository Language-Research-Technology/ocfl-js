import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import type { FixityProgress } from '../src/index.ts';
import { createObject, objectRootOf, useTempRoots } from './helpers/drafts.ts';

/** Runs `fn`, collecting every read stream opened meanwhile */
async function trackReadStreams<T>(fn: () => Promise<T>): Promise<{ streams: fs.ReadStream[]; outcome: PromiseSettledResult<T> }> {
  const streams: fs.ReadStream[] = [];
  const real = fs.createReadStream;
  const spy = mock.method(fs, 'createReadStream', (...args: Parameters<typeof real>) => {
    const stream = real.apply(fs, args);
    streams.push(stream);
    return stream;
  });
  try {
    const [outcome] = await Promise.allSettled([fn()]);
    return { streams, outcome: outcome as PromiseSettledResult<T> };
  } finally {
    spy.mock.restore();
  }
}

/** Files `f0.txt` to `f<count - 1>.txt`, each with its own content */
function manyFiles(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.txt`, `content ${i}`]));
}

describe('progress and cancelling of a fixity check', () => {
  const temp = useTempRoots('ocfl-fixity-progress-');

  it('reports progress once per stored file, ending with every file checked', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'progress', manyFiles(25));
    const seen: FixityProgress[] = [];
    assert.deepStrictEqual((await object.checkFixity({ onProgress: (progress) => seen.push({ ...progress }) })).problems, []);
    assert.strictEqual(seen.length, 25);
    assert.deepStrictEqual(
      seen.map(({ checkedFiles }) => checkedFiles),
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    assert.ok(seen.every(({ totalFiles }) => totalFiles === 25));
  });

  it('counts a changed or missing stored file as checked', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'damaged', { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const objectRoot = objectRootOf(root, 'damaged');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/b.txt'), 'changed');
    let last: FixityProgress | undefined;
    const { problems, checkedFiles } = await object.checkFixity({ onProgress: (progress) => (last = progress) });
    assert.strictEqual(problems.length, 2);
    assert.deepStrictEqual(last, { checkedFiles: 3, totalFiles: 3 });
    assert.strictEqual(checkedFiles, 3);
  });

  it('rejects with the reason of a signal already aborted, reading no stored file', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'pre-aborted', manyFiles(3));
    const reason = new Error('stop before starting');
    const { streams, outcome } = await trackReadStreams(() => object.checkFixity({ signal: AbortSignal.abort(reason) }));
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.strictEqual(streams.length, 0);
  });

  it('stops when the signal is aborted part way, rejecting with its reason and leaving no stored file open', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'aborted', manyFiles(60));
    const controller = new AbortController();
    const reason = new Error('stop part way');
    const { streams, outcome } = await trackReadStreams(() =>
      object.checkFixity({
        signal: controller.signal,
        onProgress: ({ checkedFiles }) => {
          if (checkedFiles === 5) {
            controller.abort(reason);
          }
        },
      }),
    );
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.ok(streams.length < 60, `read ${streams.length} of 60 files`);
    assert.deepStrictEqual(
      streams.filter((stream) => !stream.closed).map((stream) => stream.path),
      [],
    );
  });

  it('stops and rejects with the error onProgress throws, leaving no stored file open', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'throwing', manyFiles(60));
    const thrown = new Error('progress bar broke');
    let calls = 0;
    const { streams, outcome } = await trackReadStreams(() =>
      object.checkFixity({
        onProgress: ({ checkedFiles }) => {
          calls++;
          if (checkedFiles === 3) {
            throw thrown;
          }
        },
      }),
    );
    assert.deepStrictEqual(outcome, { status: 'rejected', reason: thrown });
    assert.strictEqual(calls, 3, 'onProgress is not called again once it has thrown');
    assert.ok(streams.length < 60, `read ${streams.length} of 60 files`);
    assert.ok(streams.every((stream) => stream.closed));
  });

  it('stops for an aborted signal that is not an instance of this realm’s AbortSignal, such as a polyfill', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'polyfilled', manyFiles(3));
    const reason = new Error('polyfill aborted');
    const signal = {
      aborted: true,
      reason,
      throwIfAborted() {
        throw reason;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const { streams, outcome } = await trackReadStreams(() => object.checkFixity({ signal: signal as never }));
    assert.deepStrictEqual(outcome, { status: 'rejected', reason });
    assert.strictEqual(streams.length, 0);
  });

  it('resolves to the sorted problems with a signal that is never aborted', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'unaborted', { 'b.txt': 'b', 'a.txt': 'a' });
    const objectRoot = objectRootOf(root, 'unaborted');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
    await fs.promises.rm(path.join(objectRoot, 'v1/content/b.txt'));
    const { problems } = await object.checkFixity({ signal: new AbortController().signal });
    assert.deepStrictEqual(
      problems.map(({ storedFile }) => path.basename(storedFile)),
      ['a.txt', 'b.txt'],
    );
  });

  describe('options it refuses', () => {
    for (const [name, options, message] of [
      ['an unknown option', { onProgess: () => {} }, /^object\.checkFixity has no option 'onProgess'\.$/],
      ['two unknown options', { signal: undefined, onProgess: () => {}, sigal: 1 }, /^object\.checkFixity has no option 'onProgess' or 'sigal'\.$/],
      ['a string', 'x', /^Options must be an object, such as \{ signal: AbortSignal\.timeout\(60_000\) \}, not 'x'$/],
      ['null', null, /^Options must be an object, such as \{ signal: AbortSignal\.timeout\(60_000\) \}, not null$/],
      ['a signal that is not an AbortSignal', { signal: { aborted: false } }, /^The signal option must be an AbortSignal, not \{ aborted: false \}$/],
      ['an onProgress that is not a function', { onProgress: 'log' }, /^The onProgress option must be a function, not 'log'$/],
    ] as const) {
      it(`throws a TypeError for ${name}, reading no stored file`, async () => {
        const root = await temp.newRoot();
        const object = await createObject(root, 'refused', manyFiles(3));
        const { streams, outcome } = await trackReadStreams(() => object.checkFixity(options as never));
        assert.strictEqual(outcome.status, 'rejected');
        const { reason } = outcome as PromiseRejectedResult;
        assert.ok(reason instanceof TypeError && message.test(reason.message), String(reason));
        assert.strictEqual(streams.length, 0);
      });
    }
  });
});
