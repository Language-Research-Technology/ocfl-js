import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';

/**
 * Each path flushed while `fn` runs: a file or directory opened with `fs.promises.open` whose handle then had `sync()` called
 * @param fn - Given the list so far, which grows as `fn` runs
 */
export async function flushedDuring(fn: (flushed: readonly string[]) => Promise<unknown>): Promise<string[]> {
  const flushed: string[] = [];
  const real = fs.promises.open;
  const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof real>) => {
    const handle = await real.apply(fs.promises, args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      flushed.push(String(args[0]));
    };
    return handle;
  });
  try {
    await fn(flushed);
  } finally {
    spy.mock.restore();
  }
  return flushed;
}

/** `flushed` without the staged locks, which are flushed under either durability, by path from `storageRoot`: `''` for the root itself */
export function flushedFrom(storageRoot: string, flushed: readonly string[]): string[] {
  return flushed.filter((file) => !path.basename(file).startsWith('.lock-')).map((file) => path.relative(storageRoot, file));
}
