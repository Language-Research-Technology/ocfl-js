import { createStorageRoot, OcflError, openStorageRoot, type StorageRoot } from '@ocfl/ocfl-fs';

async function openOrCreate(path: string): Promise<StorageRoot> {
  try {
    return await openStorageRoot(path);
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'INVALID_STORAGE_ROOT' && error.ocflCode === 'E069')) {
      throw error;
    }
    return createStorageRoot(path, { layout: { extensionName: '000N-path-direct-storage-layout' } });
  }
}

const root = await openOrCreate('/srv/ocfl');
console.log(root.ocflVersion, root.layout.extensionName);
