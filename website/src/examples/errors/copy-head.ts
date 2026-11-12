import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const full = await root.open('item-1');

await root.create('item-1-continued', { message: `Copy of the head of ${full.id}`, user: { name: 'Alice' } }, async (draft) => {
  for (const [path, file] of full.head.files) {
    await draft.write(path, file.stream());
  }
});
