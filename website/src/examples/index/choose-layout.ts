import { createStorageRoot } from '@ocfl/ocfl-fs';

// arcp://name,corpus/item/1 is stored in /srv/ocfl-by-id/name_corpus/item/1/__object__, not /srv/ocfl-by-id/arcp_name_corpus/item/1/__object__
await createStorageRoot('/srv/ocfl-by-id', {
  layout: { extensionName: '000N-path-direct-storage-layout', omitScheme: true },
});

// item-1 is stored in /srv/ocfl-hashed/599/08d/f50/572502ce…f5b773, not /srv/ocfl-hashed/599/08d/f50/59908df50572502ce…f5b773
await createStorageRoot('/srv/ocfl-hashed', {
  layout: { extensionName: '0004-hashed-n-tuple-storage-layout', shortObjectRoot: true },
});
