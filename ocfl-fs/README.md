# ocfl-fs - OCFL implementation using Filesystem storage backend for Node.js
This is JavaScript/Node.js library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it.
This package implements the OCFL client that stores storage root and its objects on a locally attached filesystem.

## Installation

    npm install @ocfl/ocfl-fs

## Usage

The storage and object methods accept an optional fs parameter, which can be any module that implements Node.js fs module API. By default, it will use the built in fs module.

```js
    const ocfl = require('@ocfl/ocfl-fs');
    const storage = ocfl.storage({root: '/var/data/myocfl'});
```

For example, by passing it memfs (https://www.npmjs.com/package/memfs) the OCFL storage will be created in memory using the memfs module:

```js
    const ocfl = require('@ocfl/ocfl-fs');
    const fs = require('memfs');
    const storage = ocfl.storage({root: '/var/data/myocfl'}, {fs});
```

For common usage documentation please refer to the [README.md in GitHub](https://github.com/Language-Research-Technology/ocfl-js)
