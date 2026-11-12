import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

try {
  await object.update({ message: 'Add notes', user: { name: 'Alice' } }, async (draft) => {
    await draft.write('notes.txt', 'Recorded in the field');
  });
} catch (error) {
  if (!(error instanceof OcflError && error.code === 'UPDATE_IN_PROGRESS')) {
    throw error;
  }
  const since = error.lockedAt?.toISOString() ?? 'an unknown time';
  console.warn(`${object.id} has had a writer since ${since}; try again later`);
}
