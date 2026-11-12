import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('item-1');

const updated = await object.update({ message: 'Reorganise', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('notes.txt', 'Checked by Alice');
  await draft.import('/data/extra/scans', 'scans');
  await draft.rename('raw', 'audio');
  await draft.copy('audio/1.wav', 'preview/1.wav');
  await draft.remove('tmp');
  await draft.reinstate('README.md', 1);
});

console.log(updated.head.number, updated === object);
