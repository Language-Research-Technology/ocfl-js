import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');
const stub = JSON.stringify({ '@context': 'https://w3id.org/ro/crate/1.1/context', '@graph': [] });

await object.update({ message: 'Deposit session 4', user: { name: 'Alice' } }, async (draft) => {
  await draft.import('/data/session-4');
  // The draft as the import left it
  const files = await draft.files();
  if (!files.has('ro-crate-metadata.json')) {
    await draft.write('ro-crate-metadata.json', stub);
  }
});
