import { createReadStream } from 'node:fs';
import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

const updated = await object.update({ message: 'Add the second session', user: { name: 'Alice', address: 'mailto:alice@example.org' } }, async (draft) => {
  await draft.write('notes.txt', 'Recorded in the field');
  await draft.write('raw/2.wav', createReadStream('/data/session-2/2.wav'));
  await draft.import('/data/session-2/photos', 'photos');
  await draft.copy('metadata.json', 'metadata.original.json');
  await draft.rename('transcript.txt', 'transcripts/1.txt');
  await draft.reinstate('consent.pdf', 1);
  await draft.remove('scratch');
});

console.log(updated.head.number, [...updated.head.files.keys()]);
