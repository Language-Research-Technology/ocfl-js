import ocfl from '../src/index.ts';

const o = ocfl.object({ root: '/test' });

class Test {}

const layout = ocfl.storageLayout('FlatDirectStorageLayout');
//let layout = new Test();
const repo = ocfl.storage({ root: '/test', layout });
