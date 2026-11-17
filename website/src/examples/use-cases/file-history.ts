import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

for (const [path, file] of object.head.files) {
  const created = `created in v${file.createdIn.number} on ${file.createdAt.toISOString()}`;
  const modified =
    file.modifiedIn.number === file.createdIn.number ? 'not modified since' : `modified in v${file.modifiedIn.number} on ${file.modifiedAt.toISOString()}`;
  console.log(`${path}: ${created}, ${modified}`);
}
