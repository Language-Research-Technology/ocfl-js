import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const original = await root.open('original-id');

await root.create('new-id', { message: 'Copy of original-id without secret.txt', user: { name: 'Alice' } }, async (draft) => {
  for (const [path, file] of original.head.files) {
    if (path !== 'secret.txt') {
      await draft.write(path, file.stream());
    }
  }
});

await root.remove('original-id');
