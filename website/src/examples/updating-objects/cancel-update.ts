import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

// Give up on a slow deposit after ten minutes: nothing is committed, and the object isn't left locked
const signal = AbortSignal.timeout(10 * 60_000);
try {
  await object.update({ message: 'Deposit session 5', user: { name: 'Alice' } }, (draft) => draft.import('/data/session-5'), { signal });
} catch (error) {
  if (error !== signal.reason) {
    throw error;
  }
  console.error('The deposit took too long and was discarded');
}
