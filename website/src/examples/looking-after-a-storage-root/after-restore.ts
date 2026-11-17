import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

// No writer can be alive: the restored storage root isn't in use yet
for await (const write of root.unfinishedWrites()) {
  console.log(`${write.id}: ${write.operation} caught by the backup, locked at ${write.lockedAt.toISOString()}`);
  await write.recover();
}
