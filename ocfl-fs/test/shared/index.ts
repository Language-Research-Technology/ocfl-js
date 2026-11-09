import type { implementOcfl } from '../../src/index.ts';
import object from './object.suite.ts';
import storage from './storage.suite.ts';
import transaction from './transaction.suite.ts';

export type Ocfl = ReturnType<typeof implementOcfl>;

export default { object, storage, transaction };
