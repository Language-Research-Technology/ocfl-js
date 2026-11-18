import fs from 'node:fs';
import { mock } from 'node:test';

/** Runs `fn`, collecting every read stream opened meanwhile */
export async function trackReadStreams<T>(fn: () => Promise<T>): Promise<{ streams: fs.ReadStream[]; outcome: PromiseSettledResult<T> }> {
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
