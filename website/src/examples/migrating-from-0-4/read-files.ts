import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

try {
  const object = await root.open('arcp://name,corpus/item/1');

  const metadata = object.head.files.get('ro-crate-metadata.json');
  if (metadata) {
    console.log(JSON.parse(await metadata.text()));
  }

  for (const [path, file] of object.head.files) {
    console.log(path, file.digest, await file.size());
  }

  const first = object.versions.get(1);
  console.log(first?.created, first?.message, first?.user?.name, first?.files.size);
} catch (error) {
  if (!(error instanceof OcflError && error.code === 'OBJECT_NOT_FOUND')) {
    throw error;
  }
  console.log('No such object');
}
