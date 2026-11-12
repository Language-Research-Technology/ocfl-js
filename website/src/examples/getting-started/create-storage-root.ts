import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('ocfl-root', {
  layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
});

console.log(root.path, root.ocflVersion);
