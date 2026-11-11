import fs from 'node:fs';
import path from 'node:path';
import { loadStorage } from '../../src/index.ts';

/** A storage root holding one object, <http://example.org/minimal_no_content>, laid out path-direct with no description of that layout */
export const STORAGE_FIXTURE: string = path.join(import.meta.dirname, '../shared/test-data/storage');

/** Names of the OCFL spec text files directly in `root` */
export async function specFiles(root: string): Promise<string[]> {
  return (await fs.promises.readdir(root)).filter((f) => /^ocfl_\d/.test(f));
}

/** Writes each file, keyed by its path relative to `dir`, making `dir` and any directories between */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  }
}

/**
 * Writes a storage root by hand, as another tool might leave it: its declaration and an `ocfl_layout.json`
 * naming the 0004 layout. The library itself only creates OCFL 1.1 roots.
 */
export async function writeStorageRoot(root: string, ocflVersion: '1.0' | '1.1'): Promise<void> {
  await writeFiles(root, {
    [`0=ocfl_${ocflVersion}`]: `ocfl_${ocflVersion}\n`,
    'ocfl_layout.json': JSON.stringify({ extension: '0004-hashed-n-tuple-storage-layout' }),
  });
}

/**
 * Writes an object into a storage root through the old API, as a `StorageRoot` can't create objects.
 * @returns The object's directory, relative to the storage root
 */
export async function writeObject(root: string, id: string): Promise<string> {
  const object = (await loadStorage({ root })).object(id);
  await object.update(async (t) => t.write('a.txt', 'content'));
  return path.relative(root, object.root);
}
