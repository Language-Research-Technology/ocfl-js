import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

const updated = await object.update({ message: 'Sync from the field laptop', user: { name: 'Alice' } }, async (draft) => {
  await draft.import('/data/item-1');
});

if (updated === object) {
  console.log(`Nothing changed: ${object.id} is still at version ${object.head.number}`);
}
