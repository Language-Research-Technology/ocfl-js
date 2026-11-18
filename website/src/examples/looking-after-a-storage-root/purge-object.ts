import { isOcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const id = 'arcp://name,corpus/item/1';

try {
  await root.purge(id);
} catch (error) {
  if (!isOcflError(error)) {
    throw error;
  }
  switch (error.code) {
    case 'OBJECT_NOT_FOUND':
      break;
    case 'OBJECT_LOCKED':
      console.error(`${id}: a writer has held the lock since ${error.lockedAt?.toISOString() ?? 'an unknown time'}; nothing was purged`);
      break;
    case 'RECOVERY_NEEDED':
      console.error(`${id}: the purge stopped part of the way through; recover it once no writer is alive`);
      break;
    default:
      throw error;
  }
}
