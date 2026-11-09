import { implementOcfl } from '@ocfl/ocfl';
import { OcflFsStore, type OcflFsStoreConfig } from './store.ts';

export type { OcflErrorCode } from '@ocfl/ocfl';
export { extensions, ObjectNotFoundError, ObjectNotLoadedError, OcflError, ValidationError } from '@ocfl/ocfl';
export type { OcflFsStoreConfig } from './store.ts';
export { OcflFsStore } from './store.ts';

// Annotated because the inferred type would name a module that @ocfl/ocfl doesn't export
const ocfl: ReturnType<typeof implementOcfl<OcflFsStoreConfig>> = implementOcfl<OcflFsStoreConfig>(OcflFsStore);

export const { OCFL_VERSIONS, createStorage, loadStorage, object, storage, storageLayout } = ocfl;
export default ocfl;
