import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

for (const version of object.versions.values()) {
  const who = version.user?.name ?? 'unknown';
  console.log(version.number, version.created.toISOString(), who, version.message ?? '');
}
