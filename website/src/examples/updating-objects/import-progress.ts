import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const object = await root.open('arcp://name,corpus/item/1');

await object.update({ message: 'Add session 6', user: { name: 'Alice' } }, async (draft) => {
  await draft.import('/data/session-6', {
    onProgress: ({ importedFiles, totalFiles }) => process.stderr.write(`\rRead ${importedFiles}/${totalFiles} files`),
  });
});
