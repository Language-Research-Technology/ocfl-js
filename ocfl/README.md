# @ocfl/ocfl - Common modules

TypeScript library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it.
This package contains abstract classes definition. Do not use this package directly. To work with an actual OCFL storage and object, use the following concrete implementation:

- `@ocfl/ocfl-fs` - File system backend

## Extensions

This library by default includes all the community extensions defined in the [OCFL Community Extensions page](https://github.com/OCFL/extensions).

To implement a local extension, first follow the description in that page, then extend `OcflExtension` (or `OcflStorageLayout` for a storage layout) and register it. For example, a storage layout:

    import { OcflStorageLayout } from '@ocfl/ocfl';
    import { storage } from '@ocfl/ocfl-fs';

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

## Implementation

A new data store backend can be implemented by creating a new package with a store class that extends the `OcflStore` class and implements its methods. Please see the source code of `@ocfl/ocfl-fs` as an example implementation.
