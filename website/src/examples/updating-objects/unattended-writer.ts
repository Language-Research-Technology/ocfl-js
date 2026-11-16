import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const source = '/data/incoming/item-1';

await root.create(
  'arcp://name,corpus/item/1',
  {
    message: `Imported from ${source}`,
    user: { name: 'corpus-import', address: 'https://github.com/example/corpus-import' },
  },
  async (draft) => {
    await draft.import(source);
  },
);
