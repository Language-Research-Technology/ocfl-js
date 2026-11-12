import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('/srv/ocfl', {
  layout: { extensionName: '000N-path-direct-storage-layout' },
});

// Stored in /srv/ocfl/arcp_name_corpus/item/1/__object__
await root.create('arcp://name,corpus/item/1', { message: 'First version', user: { name: 'Alice' } }, async (draft) => {
  await draft.import('/data/corpus/item-1');
});
