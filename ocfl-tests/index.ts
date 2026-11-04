import type { implementOcfl } from '@ocfl/ocfl';
import object from './object.spec.ts';
import storage from './storage.spec.ts';

export type Ocfl = ReturnType<typeof implementOcfl>;

export default { object, storage };
