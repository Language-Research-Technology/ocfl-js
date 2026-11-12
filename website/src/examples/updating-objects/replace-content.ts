import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

await object.update({ message: 'Replace with the corrected deposit', user: { name: 'Alice' } }, async (draft) => {
  await draft.clear();
  await draft.import('/data/item-1-corrected');
});
