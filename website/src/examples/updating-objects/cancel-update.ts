import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

// Give up on a slow import after ten minutes: nothing is committed, and the object isn't left locked
const signal = AbortSignal.timeout(10 * 60_000);
try {
  // Merges: the head's other files stay
  await object.update({ message: 'Add session 5', user: { name: 'Alice' }, signal }, (draft) => draft.import('/data/session-5'));
} catch (error) {
  if (error !== signal.reason) {
    throw error;
  }
  console.error('The update took too long and was discarded');
}
