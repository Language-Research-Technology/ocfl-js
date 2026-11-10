import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { isErrnoException } from '../src/utils.ts';

type FsMethod = 'rename' | 'copyFile' | 'writeFile' | 'readFile' | 'readdir' | 'rmdir' | 'rm' | 'opendir' | 'stat';
type Fails = (source: string, target: string) => boolean;

export function fsError(code: string) {
  return Object.assign(new Error('injected failure'), { code });
}

export function failFsMethod(method: FsMethod, fails: Fails, code = 'EIO') {
  const fsp = fs.promises as unknown as Record<FsMethod, (...args: unknown[]) => Promise<unknown>>;
  const real = fsp[method];
  return mock.method(fsp, method, async (...args: unknown[]) => {
    if (fails(String(args[0]), String(args[1]))) {
      throw fsError(code);
    }
    return real.apply(fs.promises, args);
  });
}

export function failRename(code: string, fails: Fails = () => true) {
  return failFsMethod('rename', fails, code);
}

/** Renames in or out of `dir` fail as if it were a separate filesystem. */
export function mountSeparately(dir: string) {
  const inside = (p: string) => p === dir || p.startsWith(dir + path.sep);
  return failRename('EXDEV', (from, to) => inside(from) !== inside(to));
}

export async function withFsFailure<T>(method: FsMethod, failing: string | Fails, fn: () => Promise<T>, code?: string) {
  const fails = typeof failing === 'string' ? (source: string, target: string) => source === failing || target === failing : failing;
  const spy = failFsMethod(method, fails, code);
  try {
    return await fn();
  } finally {
    spy.mock.restore();
  }
}

export async function trackOpendir(fn: () => Promise<unknown>) {
  const opened: fs.Dir[] = [];
  const real = fs.promises.opendir;
  const spy = mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof real>) => {
    const dir = await real.apply(fs.promises, args);
    opened.push(dir);
    return dir;
  });
  try {
    await fn();
  } finally {
    spy.mock.restore();
  }
  return opened;
}

/** Paths of the given directories that were still open, closing them */
export async function stillOpen(dirs: fs.Dir[]) {
  const open = [];
  for (const dir of dirs) {
    try {
      await dir.read();
      open.push(dir.path);
      await dir.close();
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ERR_DIR_CLOSED') {
        throw error;
      }
    }
  }
  return open;
}

/**
 * Opens of matching paths, by `fs.open` or `fs.promises.open`, complete `ms` after `fn` starts.
 * `opened` settles once the first has completed.
 */
export async function withSlowOpens<T>(matches: (filePath: string) => boolean, ms: number, fn: (opened: Promise<void>) => Promise<T>) {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
  const realOpen = fs.open as unknown as (...args: unknown[]) => void;
  const realOpenPromise = fs.promises.open;
  const spies = [
    mock.method(fs, 'open', (...args: unknown[]) => {
      if (!matches(String(args[0]))) {
        return realOpen.apply(fs, args);
      }
      const callback = args.at(-1) as (...result: unknown[]) => void;
      released.then(() =>
        realOpen.apply(fs, [
          ...args.slice(0, -1),
          (...result: unknown[]) => {
            callback(...result);
            markOpened();
          },
        ]),
      );
    }),
    mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpenPromise>) => {
      if (!matches(String(args[0]))) {
        return realOpenPromise.apply(fs.promises, args);
      }
      await released;
      try {
        return await realOpenPromise.apply(fs.promises, args);
      } finally {
        markOpened();
      }
    }),
  ];
  const timer = setTimeout(release, ms);
  try {
    return await fn(opened);
  } finally {
    clearTimeout(timer);
    release();
    for (const spy of spies) {
      spy.mock.restore();
    }
  }
}

/** Writes through a `FileHandle` fail */
export async function withFileWriteFailure<T>(fn: () => Promise<T>, code = 'EIO') {
  const probe = await fs.promises.open(os.devNull);
  const fileHandle = Object.getPrototypeOf(probe) as Record<'write' | 'writev' | 'writeFile', () => Promise<never>>;
  await probe.close();
  const spies = (['write', 'writev', 'writeFile'] as const).map((method) =>
    mock.method(fileHandle, method, async () => {
      throw fsError(code);
    }),
  );
  try {
    return await fn();
  } finally {
    for (const spy of spies) {
      spy.mock.restore();
    }
  }
}
