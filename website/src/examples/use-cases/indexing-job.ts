import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const index = new Map<string, { version: number; files: string[] }>();
const damaged: string[] = [];

for await (const entry of root.objects()) {
  if ('error' in entry) {
    const { objectRoot, id, error } = entry;
    damaged.push(`${error.ocflCode ?? error.code}: ${objectRoot}${id ? ` (${id})` : ''}`);
    continue;
  }
  const { object } = entry;
  index.set(object.id, { version: object.head.number, files: [...object.head.files.keys()] });
}

console.log(`Indexed ${index.size} objects`);
for (const line of damaged) {
  console.warn(line);
}
