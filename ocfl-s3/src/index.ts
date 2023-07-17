import { Ocfl } from '@ocfl/ocfl';

import { OcflS3Store } from './lib/store.js';

let defaultOptions = { };
export default new Ocfl(OcflS3Store, defaultOptions);
