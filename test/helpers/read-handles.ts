import fs from 'node:fs';
import { mock } from 'node:test';

/** Runs `fn`, collecting every file handle opened read-only meanwhile, as stored files are */
export async function trackReadHandles<T>(fn: () => Promise<T>): Promise<{ handles: fs.promises.FileHandle[]; outcome: PromiseSettledResult<T> }> {
  const handles: fs.promises.FileHandle[] = [];
  const real = fs.promises.open;
  const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
    const handle = await real.apply(fs.promises, args);
    if (typeof args[1] === 'number' && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
      handles.push(handle);
    }
    return handle;
  });
  try {
    const [outcome] = await Promise.allSettled([fn()]);
    return { handles, outcome: outcome as PromiseSettledResult<T> };
  } finally {
    spy.mock.restore();
  }
}

/** Whether `handle` has been closed */
export const isClosed = (handle: fs.promises.FileHandle): boolean => handle.fd === -1;
