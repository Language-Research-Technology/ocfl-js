import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

await object.update({ message: 'Fold the drafts into the transcripts', user: { name: 'Alice' } }, async (draft) => {
  await draft.rename('drafts', 'transcripts', { merge: true });
});
