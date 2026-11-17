import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

for await (const entry of root.objects()) {
  switch (entry.status) {
    case 'opened':
      console.log(entry.object.id, entry.object.head.number);
      break;
    case 'damaged': {
      const { objectRoot, id, error } = entry;
      console.warn(`${objectRoot}${id ? ` (${id})` : ''}: ${error.ocflCode ?? error.code}`);
      break;
    }
    default:
      console.warn('Unknown listed entry, skipped');
  }
}
