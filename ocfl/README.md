# ocfl-js - Common modules
This is JavaScript/Node.js library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it. 
This package contains abstract classes definition. Do not use this package directly. To work with an actual OCFL storage and object, use the following concrete implementation:
* ocfl-fs - File system storage backend

## Extensions
This library by default includes all the community extensions defined in the [OCFL Community Extensions page](https://github.com/OCFL/extensions). The implementation is organised in the ocfl-extensions package. 

To implement a local extension in this library, first follow the description in that page, then create a function like in the following example:

    const ocfl = require(ocfl-fs);
    ocfl.extensions['9999-local-test'] = function (Storage, Object) {

       
    }

