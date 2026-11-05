import { implementOcfl, type OcflApi } from '@ocfl/ocfl';
import { OcflFsStore, type OcflFsStoreConfig } from './store.ts';

export { ObjectNotFoundError, ObjectNotLoadedError } from '@ocfl/ocfl';
export type { OcflFsStoreConfig } from './store.ts';
export { OcflFsStore } from './store.ts';

type Api = OcflApi<OcflFsStoreConfig>;
const ocfl: Api = implementOcfl<OcflFsStoreConfig>(OcflFsStore);

export const OCFL_VERSIONS: Api['OCFL_VERSIONS'] = ocfl.OCFL_VERSIONS;
export const StorageLayout: Api['StorageLayout'] = ocfl.StorageLayout;
export const createStorage: Api['createStorage'] = ocfl.createStorage;
export const loadStorage: Api['loadStorage'] = ocfl.loadStorage;
export const object: Api['object'] = ocfl.object;
export const storage: Api['storage'] = ocfl.storage;
export const storageLayout: Api['storageLayout'] = ocfl.storageLayout;
export default ocfl;
