import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('item-1');

await object.version(1).exportTo('/tmp/item-1-v1', {
  signal: AbortSignal.timeout(10 * 60_000),
  onProgress: ({ exportedFiles, totalFiles }) => console.log(`${exportedFiles} of ${totalFiles} files written`),
});
