import { implementOcfl } from './core.ts';
import { OcflFsStore, type OcflFsStoreConfig } from './store.ts';

export * from './core.ts';
export type { OcflFsStoreConfig } from './store.ts';
export { OcflFsStore } from './store.ts';

const ocfl = implementOcfl<OcflFsStoreConfig>(OcflFsStore);

export const { OCFL_VERSIONS, createStorage, loadStorage, object, storage, storageLayout } = ocfl;
export default ocfl;
