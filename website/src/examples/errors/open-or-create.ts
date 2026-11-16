import { createStorageRoot, OcflError, openStorageRoot, type StorageRoot } from '@ocfl/ocfl-fs';

async function openOrCreate(path: string): Promise<StorageRoot> {
  try {
    return await openStorageRoot(path);
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'STORAGE_ROOT_NOT_FOUND')) {
      throw error;
    }
    return createStorageRoot(path, { layout: { extensionName: '0004-hashed-n-tuple-storage-layout' } });
  }
}

const root = await openOrCreate('/srv/ocfl');
console.log(root.layout.extensionName);
