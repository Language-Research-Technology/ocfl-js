import fs from 'node:fs';
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
