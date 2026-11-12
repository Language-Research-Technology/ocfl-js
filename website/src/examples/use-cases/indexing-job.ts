import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const index = new Map<string, { version: number; files: string[] }>();
const damaged: OcflError[] = [];

for await (const entry of root.objects()) {
  if (entry instanceof OcflError) {
    damaged.push(entry);
    continue;
  }
  index.set(entry.id, { version: entry.head.number, files: [...entry.head.files.keys()] });
}

console.log(`Indexed ${index.size} objects`);
for (const error of damaged) {
  console.warn(`${error.code}${error.ocflCode ? ` (${error.ocflCode})` : ''}: ${error.message}`);
}
