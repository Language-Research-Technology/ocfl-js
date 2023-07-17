# ocfl-s3 - OCFL implementation using S3 storage backend for Node.js
This is JavaScript/Node.js library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it.
This package implements the OCFL client that stores storage root and its objects in an S3 bucket.

## Installation

```bash
    npm install @ocfl/ocfl-s3
```

## Usage

```js
    const ocfl = require('@ocfl/ocfl-fs');
    const storage = ocfl.storage({ bucket: 'my-ofcl-bucket' });
```

For common usage documentation please refer to the [README.md in GitHub](https://github.com/Language-Research-Technology/ocfl-js)
