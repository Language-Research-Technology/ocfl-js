const ocfl = require('../index.js');

let o = ocfl.object({root: '/test'});

class Test {

}

let layout = ocfl.storageLayout('FlatDirectStorageLayout');
//let layout = new Test();
let repo = ocfl.storage({root: '/test', layout});
