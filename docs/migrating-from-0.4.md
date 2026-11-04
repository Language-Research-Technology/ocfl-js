# Migrating from 0.4

This release converts `@ocfl/ocfl` and `@ocfl/ocfl-fs` to TypeScript, ships them as ES modules with type declarations, and tightens how they handle invalid input. Most code that uses `@ocfl/ocfl-fs` through its default export keeps working once Node.js is upgraded. The sections below cover what may need changing.

## Node.js 22.12 or later

Both packages now require Node.js 22.12 or later (previously 18). Digests are computed with `node:crypto` and `node:zlib`, and `zlib.crc32` was added in Node.js 22.2.

## ES modules

Both packages are ESM-only and publish compiled code from `dist/`.

- **CommonJS** callers can still `require()` the packages, because Node.js 22.12 supports `require()` of ES modules:

  ```js
  const ocfl = require('@ocfl/ocfl-fs');
  const storage = ocfl.storage({ root: '/var/data/myocfl' });
  ```

- **`@ocfl/ocfl` has no default export.** Use named imports or a namespace import:

  ```diff
  - import ocfl from '@ocfl/ocfl';
  + import { OcflStorageLayout, implementOcfl } from '@ocfl/ocfl';
  + // or
  + import * as ocfl from '@ocfl/ocfl';
  ```

  `@ocfl/ocfl-fs` keeps its default export (`import ocfl from '@ocfl/ocfl-fs'`).

- **Only the package root can be imported.** `index.mjs` and `lib/` no longer exist.

## TypeScript

The packages now declare their own types, so delete any hand-written module declarations for `@ocfl/ocfl` or `@ocfl/ocfl-fs`.

The declarations show where a value can be missing, so code that assumed otherwise may no longer compile. The most common cases:

| API                                                                                | Now returns                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `object.getInventory()`                                                            | `Promise<OcflObjectInventory \| undefined>`, `undefined` when the object has no inventory yet |
| `object.inventory`                                                                 | `OcflObjectInventory \| undefined` until the object is loaded                                 |
| `object.getFile()`, `fileByLogicalPath()`, `fileByDigest()`, `fileByContentPath()` | `undefined` when the file isn't found                                                         |
| `object.id`, `object.workspace`                                                    | `string \| undefined`                                                                         |
| `inventory.getDigest()`, `inventory.versionState()`                                | `undefined` for an unknown logical path or version                                            |
| `file.size`, `file.lastModified`                                                   | `number \| undefined`; set only when the object was loaded with `{ filesMetadata: true }`     |

Optional config properties (`OcflStorageConfig`, `OcflObjectConfig`, commit and remove options) accept an explicit `undefined`, so they work with `exactOptionalPropertyTypes`.

## Option values are matched exactly

Option values used to be matched case-insensitively. They now have to match exactly:

| Option                                              | Accepted values                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `digestAlgorithm` for objects and storage           | `'sha256'`, `'sha512'`                                                                          |
| `digestAlgorithm` for storage layouts 0003 and 0004 | `'md5'`, `'sha1'`, `'sha256'`, `'sha512'`, `'sha512/256'`, `'blake2b-512'`, `'crc32'`, `'size'` |
| `update()` / `import()` mode                        | `'MERGE'`, `'REPLACE'`                                                                          |

For example, `digestAlgorithm: 'SHA512'` and `update(fn, 'replace')` now throw. A layout configured with `digestAlgorithm: 'MD5'` used to pass validation and then fail on the first `map()`. It is now rejected when the layout is created.

## Digest algorithms

- `blake2b-160`, `blake2b-256` and `blake2b-384` are no longer supported, because `node:crypto` doesn't provide them. `blake2b-512` is still supported.
- `OcflDigest.FIXITY` has been removed.
- `OcflDigest.CONTENT` is now a plain array, `['sha256', 'sha512']`, instead of an enumeration.

## Errors for invalid OCFL content

Spec violations now throw a `ValidationError` (a subclass of `Error`) carrying the OCFL validation `code`, a `description` and a `path`. Check `error.code` rather than matching on the message, because the messages have changed.

| Code | Raised when                                                                          |
| ---- | ------------------------------------------------------------------------------------ |
| E007 | An object's version declaration has the wrong contents (previously reported as E006) |
| E036 | An inventory has no `head`                                                           |
| E040 | An inventory's `head` is empty or isn't one of its versions                          |
| E050 | An inventory's state lists a digest that isn't in its manifest                       |
| E060 | The inventory sidecar digest doesn't match the inventory                             |
| E069 | A storage root has no conformance declaration                                        |
| E080 | A storage root's version declaration has the wrong contents                          |
| E082 | An object root is nested inside another object                                       |

E036, E040 and E050 are checked when the inventory is read. A malformed object that used to load, and then failed later with a `TypeError`, now fails in `load()` or `getInventory()`.

Other invalid input that used to cause a `TypeError` now throws a descriptive error:
- an unsupported storage layout or extension name
- calling `count()` or `files()` on an object that has no inventory
- calling `storage.object()` with neither an id nor a root

## Other behaviour changes

- Looking up a file in a version that doesn't exist returns `undefined` (or `0` from `count()`) instead of throwing.
- `object.import()` no longer empties the array of sources passed to it.
