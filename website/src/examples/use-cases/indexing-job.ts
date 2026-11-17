import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const index = new Map<string, { version: number; files: string[] }>();
const damaged: string[] = [];

for await (const entry of root.objects()) {
  switch (entry.status) {
    case 'opened': {
      const { object } = entry;
      index.set(object.id, { version: object.head.number, files: [...object.head.files.keys()] });
      break;
    }
    case 'damaged': {
      const { objectRoot, id, error } = entry;
      damaged.push(`${error.ocflCode ?? error.code}: ${objectRoot}${id ? ` (${id})` : ''}`);
      break;
    }
    default:
      console.warn('Unknown listed entry, skipped');
  }
}

console.log(`Indexed ${index.size} objects`);
for (const line of damaged) {
  console.warn(line);
}
