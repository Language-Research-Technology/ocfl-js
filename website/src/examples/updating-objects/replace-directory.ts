import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

await object.update({ message: 'Replace the photos', user: { name: 'Alice' } }, async (draft) => {
  await draft.remove('photos');
  await draft.import('/data/session-2/photos', 'photos');
});
