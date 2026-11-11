import fs from 'node:fs';
import path from 'node:path';

/** Directories under `dir`, at any depth, that have no entries */
export async function emptyDirectoriesUnder(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(e.parentPath, e.name));
  const sizes = await Promise.all(dirs.map(async (d) => [d, (await fs.promises.readdir(d)).length] as const));
  return sizes.filter(([, size]) => size === 0).map(([d]) => d);
}
