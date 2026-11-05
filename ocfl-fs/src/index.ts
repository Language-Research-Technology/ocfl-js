import { implementOcfl } from '@ocfl/ocfl';
import { OcflFsStore, type OcflFsStoreConfig } from './store.ts';

export { ObjectNotFoundError, ObjectNotLoadedError } from '@ocfl/ocfl';
export type { OcflFsStoreConfig } from './store.ts';
export { OcflFsStore } from './store.ts';

const ocfl = implementOcfl<OcflFsStoreConfig>(OcflFsStore);

export const { OCFL_VERSIONS, StorageLayout, createStorage, loadStorage, object, storage, storageLayout } = ocfl;
export default ocfl;
