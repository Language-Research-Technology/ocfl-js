# @ocfl/ocfl-fs - OCFL implementation using Filesystem storage backend for Node.js

TypeScript library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it.
This package implements the OCFL client that stores storage root and its objects on a locally attached filesystem.

## Installation

    npm install @ocfl/ocfl-fs

## Usage

The storage and object methods accept an optional fs parameter, which can be any module that implements Node.js fs module API. By default, it will use the built in fs module.

    import ocfl from '@ocfl/ocfl-fs';
    const storage = ocfl.storage({root: '/var/data/myocfl'});

For example, by passing it memfs (https://www.npmjs.com/package/memfs) the OCFL storage will be created in memory using the memfs module:

    import ocfl from '@ocfl/ocfl-fs';
    import { fs } from 'memfs';
    const storage = ocfl.storage({root: '/var/data/myocfl'}, {fs});

For common usage documentation please refer to the [README.md in GitHub](https://github.com/Language-Research-Technology/ocfl-js)

## Extensions

This library by default includes all the community extensions defined in the [OCFL Community Extensions page](https://github.com/OCFL/extensions).

To implement a local extension, first follow the description in that page, then extend `OcflExtension` (or `OcflStorageLayout` for a storage layout) and register it. For example, a storage layout:

    import { OcflStorageLayout, storage } from '@ocfl/ocfl-fs';

    class UppercaseLayout extends OcflStorageLayout {
      static get NAME() {
        return '9999-uppercase-layout';
      }
      static get DESCRIPTION() {
        return 'Maps an object id to an uppercase directory name';
      }

      map(id: string): string {
        return id.toUpperCase();
      }
    }

    UppercaseLayout.register();

    const s = storage({ root: '/var/data/ocfl', layout: '9999-uppercase-layout' });

## Implementing another backend

A new data store backend can be implemented with a store class that extends `OcflStore`, passed to `implementOcfl`. Please see `OcflFsStore` in the source code as an example implementation.
