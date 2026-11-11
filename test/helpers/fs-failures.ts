import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { isErrnoException } from '../../src/utils.ts';

type FsMethod = 'mkdir' | 'open' | 'rename' | 'copyFile' | 'writeFile' | 'readFile' | 'readdir' | 'rmdir' | 'rm' | 'opendir' | 'stat';
type Fails = (source: string, target: string) => boolean;

/** Matches a move from a path ending in `from` to one ending in `to` */
export const moving =
  (from: string, to: string): Fails =>
  (source, target) =>
    source.endsWith(from) && target.endsWith(to);

export function fsError(code: string) {
  return Object.assign(new Error('injected failure'), { code });
}

/** @param applied - Whether a failing call takes effect before it fails, as when its reply is lost */
export function failFsMethod(method: FsMethod, fails: Fails, code = 'EIO', applied = false) {
  const fsp = fs.promises as unknown as Record<FsMethod, (...args: unknown[]) => Promise<unknown>>;
  const real = fsp[method];
  return mock.method(fsp, method, async (...args: unknown[]) => {
    if (fails(String(args[0]), String(args[1]))) {
      if (applied) {
        await real.apply(fs.promises, args);
      }
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

export async function withFsFailure<T>(method: FsMethod, failing: string | Fails, fn: () => Promise<T>, code?: string, applied?: boolean) {
  const fails = typeof failing === 'string' ? (source: string, target: string) => source === failing || target === failing : failing;
  const spy = failFsMethod(method, fails, code, applied);
  try {
    return await fn();
  } finally {
    spy.mock.restore();
  }
}

/** {@link withFsFailure} where the failing call takes effect and then fails, as when its reply is lost */
export function withLostReply<T>(method: FsMethod, failing: string | Fails, fn: () => Promise<T>) {
  return withFsFailure(method, failing, fn, 'EIO', true);
}

/** Runs `fn` with `before` called once, just before the first call of `method` whose path argument at `position` is `file` */
async function beforeCalling<T>(method: 'open' | 'rename', position: 0 | 1, file: string, before: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const fsp = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = fsp[method] as (...args: unknown[]) => Promise<unknown>;
  let called = false;
  const spy = mock.method(fsp, method, async (...args: unknown[]) => {
    if (!called && String(args[position]) === file) {
      called = true;
      await before();
    }
    return real.apply(fs.promises, args);
  });
  try {
    const result = await fn();
    assert.ok(called, `${method} was never called for ${file}`);
    return result;
  } finally {
    spy.mock.restore();
  }
}

/** Runs `fn` with `beforeOpen` called once, just before the first file at `file` is opened */
export function beforeOpening<T>(file: string, beforeOpen: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  return beforeCalling('open', 0, file, beforeOpen, fn);
}

/** Runs `fn` with `beforeRename` called once, just before something is first renamed to `target` */
export function beforeRenamingTo<T>(target: string, beforeRename: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  return beforeCalling('rename', 1, target, beforeRename, fn);
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
