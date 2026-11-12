import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
// When this host, the storage root's only writer, came back up
const restartedAt = new Date('2026-11-12T03:20:00Z');

for await (const write of root.unfinishedWrites()) {
  console.log(`${write.id}: locked at ${write.lockedAt.toISOString()}${write.removing ? ', being removed' : ''}`);
  if (write.lockedAt < restartedAt) {
    await write.recover();
  }
}
