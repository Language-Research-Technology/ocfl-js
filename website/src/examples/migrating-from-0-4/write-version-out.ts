import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('item-1');
const targetDir = path.resolve('/tmp/item-1-v1');

for (const [logicalPath, file] of object.versions.get(1)?.files ?? []) {
  const target = path.resolve(targetDir, logicalPath);
  if (!target.startsWith(targetDir + path.sep)) {
    throw new Error(`Logical path "${logicalPath}" is outside ${targetDir}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.stream());
}
