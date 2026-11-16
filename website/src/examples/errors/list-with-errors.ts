import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

for await (const entry of root.objects()) {
  if ('error' in entry) {
    const { objectRoot, id, error } = entry;
    console.warn(`${objectRoot}${id ? ` (${id})` : ''}: ${error.ocflCode ?? error.code}`);
    continue;
  }
  console.log(entry.object.id, entry.object.head.number);
}
