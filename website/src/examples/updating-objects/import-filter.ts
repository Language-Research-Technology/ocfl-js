import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

await object.update({ message: 'Deposit session 6', user: { name: 'Alice' } }, async (draft) => {
  await draft.import('/data/session-6', {
    filter: (_, entry) => entry.name !== '.git' && entry.name !== '.DS_Store' && !entry.name.startsWith('._') && !entry.isSymbolicLink(),
  });
});
