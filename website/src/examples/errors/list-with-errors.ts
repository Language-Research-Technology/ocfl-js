import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

for await (const object of root.objects()) {
  if (object instanceof OcflError) {
    console.warn(`${object.ocflCode ?? object.code}: ${object.message}`);
    continue;
  }
  console.log(object.id, object.head.number);
}
