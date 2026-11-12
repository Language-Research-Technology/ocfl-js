import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('/srv/ocfl', {
  layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
});

const object = await root.create('greeting', { message: 'First version', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('hello.txt', 'Hello, world');
});

const updated = await object.update({ message: 'Add a note', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('notes/today.txt', 'Recorded in the field');
});

for (const [path, file] of updated.head.files) {
  console.log(path, await file.text());
}
