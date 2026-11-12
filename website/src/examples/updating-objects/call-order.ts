import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

const updated = await object.update({ message: 'Add the third session', user: { name: 'Alice' } }, async (draft) => {
  await Promise.all([
    draft.import('/data/session-3/audio', 'raw'),
    draft.import('/data/session-3/photos', 'photos'),
    draft.write('raw/README.txt', 'Recorded on a handheld recorder'),
  ]);
});

console.log(await updated.head.files.get('raw/README.txt')?.text());
