import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';

type FsMethod = 'rename' | 'copyFile' | 'writeFile' | 'rmdir' | 'rm';
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

export async function withFsFailure<T>(method: FsMethod, failing: string | Fails, fn: () => Promise<T>) {
  const fails = typeof failing === 'string' ? (source: string, target: string) => source === failing || target === failing : failing;
  const spy = failFsMethod(method, fails);
  try {
    return await fn();
  } finally {
    spy.mock.restore();
  }
}
