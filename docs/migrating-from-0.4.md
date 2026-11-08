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

| API                                                                                | Now returns                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `object.getInventory()`                                                            | `Promise<OcflObjectInventory \| undefined>`, `undefined` when the object has no inventory yet                |
| `object.inventory`                                                                 | `OcflObjectInventory \| undefined` until the object is loaded                                                |
| `object.getFile()`, `fileByLogicalPath()`, `fileByDigest()`, `fileByContentPath()` | `undefined` when the object has no such file (see [Errors for missing objects](#errors-for-missing-objects)) |
| `object.id`, `object.workspace`                                                    | `string \| undefined`                                                                                        |
| `inventory.getDigest()`, `inventory.versionState()`                                | `undefined` for an unknown logical path or version                                                           |
| `file.size`, `file.lastModified`                                                   | `number \| undefined`; set only when the object was loaded with `{ filesMetadata: true }`                    |

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

## Error classes and codes

Errors a client is expected to handle are now an `OcflError` with a string `code`. Check `error.code` rather than matching on the message: messages aren't part of the API and may change. `OcflError`, its subclasses `ValidationError`, `ObjectNotFoundError` and `ObjectNotLoadedError`, and the `OcflErrorCode` union are exported from both `@ocfl/ocfl` and `@ocfl/ocfl-fs`:

```ts
import type { OcflError } from '@ocfl/ocfl-fs';

try {
  await object.update(async (t) => t.write('a.txt', 'a'));
} catch (error) {
  if ((error as OcflError).code === 'UPDATE_IN_PROGRESS') {
    // retry later
  }
}
```

`instanceof OcflError` works because `@ocfl/ocfl` is a peer dependency, so your app and `@ocfl/ocfl-fs` share one copy. Checking `error.code` works even if a second copy is installed, for example when your own `@ocfl/ocfl` dependency is outside the peer range.

| Code                          | Thrown when                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OBJECT_NOT_FOUND`            | The object doesn't exist; thrown as an `ObjectNotFoundError` (see [Errors for missing objects](#errors-for-missing-objects)) |
| `OBJECT_NOT_LOADED`           | `getFile()` is called before the inventory has been read; thrown as an `ObjectNotLoadedError`                                |
| `UPDATE_IN_PROGRESS`          | An update finds uncommitted changes, because another process is updating the object or an earlier update failed              |
| `DIRECTORY_NOT_EMPTY`         | An object or storage root is created in a non-empty directory                                                                |
| `ID_INCOMPATIBLE_WITH_LAYOUT` | The storage layout can't map the object id                                                                                   |
| `UNSUPPORTED_LAYOUT`          | A storage root's `ocfl_layout.json` names a layout this library doesn't support                                              |
| `INVALID_LOGICAL_PATH`        | A logical path is absolute or has a `..` segment, such as `a/../b` or `..\b`                                                 |
| `FILE_NOT_FOUND`              | A lazy file's content isn't in the object, or `copy()` or `rename()` names a source the object doesn't contain               |
| `E007`, `E036`, …             | The content violates the OCFL spec; see below                                                                                |

Other errors, such as invalid configuration or arguments, are programming mistakes and remain a plain `Error` or `TypeError`. That includes an unsupported layout named in your own config.

When `object.import()` fails for one or more sources, it throws an `AggregateError`. Its `errors` holds the error for each failed source, with its `code` where it has one. A failed directory source is itself an `AggregateError` of the errors for its files.

## Errors for invalid OCFL content

Spec violations now throw a `ValidationError`, an `OcflError` whose `code` is the OCFL validation code. It also carries a `description` and a `path`. The messages have changed from earlier versions.

| Code | Raised when                                                                          |
| ---- | ------------------------------------------------------------------------------------ |
| E007 | An object's version declaration has the wrong contents (previously reported as E006) |
| E036 | An inventory has no `head`                                                           |
| E040 | An inventory's `head` is empty or isn't one of its versions                          |
| E050 | An inventory's state lists a digest that isn't in its manifest                       |
| E060 | The inventory sidecar digest doesn't match the inventory                             |
| E069 | A storage root has no conformance declaration                                        |
| E080 | A storage root's version declaration has the wrong contents                          |
| E081 | A storage is loaded with an `ocflVersion` later than its root's version declaration  |
| E082 | An object root is nested inside another object                                       |

E036, E040 and E050 are checked when the inventory is read. A malformed object that used to load, and then failed later with a `TypeError`, now fails in `load()` or `getInventory()`.

Other invalid input that used to cause a `TypeError` now throws a descriptive error:
- an unsupported storage layout or extension name
- calling `count()` or `files()` on an object that has no inventory
- calling `storage.object()` with neither an id nor a root

## Validation methods removed

The library reads and writes OCFL objects and storage roots, but it isn't a validator. It raises a `ValidationError` only for the codes listed under [Errors for invalid OCFL content](#errors-for-invalid-ocfl-content), and only when it finds the problem while opening, reading or writing an object or storage root.

These stub methods have been removed:

- `OcflObject.validate()` and `OcflObject.verify()`, which only ever threw `Not Implemented`
- `OcflStorageLayout.validate()`, which did nothing. Custom layouts that override it or call `super.validate()` should drop that code.

To check an object or storage root against the spec, use a dedicated OCFL validator.

## Errors for missing objects

`getFile()` and the `fileBy*()` methods used to return `undefined` whether the object wasn't loaded, didn't exist, or didn't contain the file. Only the last case still returns `undefined`:

| Case                                           | `getFile()`                   | `fileByLogicalPath()`, `fileByDigest()`, `fileByContentPath()` |
| ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| The inventory hasn't been read yet<sup>1</sup> | throws `ObjectNotLoadedError` | read the inventory as before                                   |
| The object doesn't exist (no inventory)        | throws `ObjectNotFoundError`  | throw `ObjectNotFoundError`                                    |
| The object exists but doesn't contain the file | `undefined`                   | `undefined`                                                    |

<sup>1</sup> By `load()`, or by any method that reads the inventory, such as `getInventory()`, `count()`, `files()`, `fileBy*()` or `update()`.

`getFile(..., true)` (lazy) still returns a file instance without a loaded inventory. `count()`, `files()`, and reading the content of a lazy file looked up by logical path or digest, also throw `ObjectNotFoundError` when the object doesn't exist.

Both are `OcflError`s, with codes `OBJECT_NOT_FOUND` and `OBJECT_NOT_LOADED`, and are exported from `@ocfl/ocfl` and `@ocfl/ocfl-fs`:

```ts
import { ObjectNotFoundError } from '@ocfl/ocfl-fs';

await object.load();
try {
  const file = object.getFile('data.csv');
  if (!file) return reply.code(404).send();
  return reply.send(await file.stream());
} catch (e) {
  if (e instanceof ObjectNotFoundError) return reply.code(404).send();
  throw e;
}
```

## Storage layout 0003 paths

`0003-hash-and-id-n-tuple-storage-layout` now builds the encapsulation directory as the [extension](https://ocfl.github.io/extensions/0003-hash-and-id-n-tuple-storage-layout.html) specifies, so storage roots it wrote can be read by other implementations and vice versa. The digest-tuple directories are unchanged. There is no fallback: an object written under the old name isn't found until it's moved.

An object is affected if its id has any of these:

| Id contains                           | Old directory name      | New directory name                                   |
| ------------------------------------- | ----------------------- | ---------------------------------------------------- |
| Upper-case letters                    | Lower-cased: `object-a` | Case kept: `Object-A`                                |
| Any of `!'()*~`                       | Left as is: `a!b`       | Percent-encoded: `a%21b`                             |
| More than 100 characters once encoded | The whole encoded id    | First 100 characters, `-`, then the id's full digest |

To move existing objects, compute each object's directory name under both rules and rename it if they differ. An object's id is the `id` in its `inventory.json`:

```ts
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import ocfl from '@ocfl/ocfl-fs';

const storage = await ocfl.loadStorage({ root: '/var/data/myocfl' });

const oldName = (id: string) => encodeURIComponent(id).toLowerCase().replace(/\./g, '%2e');

async function moveObject(id: string) {
  const newPath = storage.objectRootAbs(id);
  const oldPath = path.join(path.dirname(newPath), oldName(id));
  if (oldPath !== newPath && existsSync(oldPath)) await rename(oldPath, newPath);
}
```

## Other behaviour changes

- Looking up a file in a version that doesn't exist returns `undefined` (or `0` from `count()`) instead of throwing.
- `object.import()` no longer empties the array of sources passed to it.
- Importing a directory fails if any of its files fails. Previously the other files were committed and the failures were dropped.
- An update that leaves a stream from `createWritable()` open now rolls back and rejects with "Unfinished operations detected" instead of never settling.
- When an `update()` callback throws after one of its operations failed, the update now rolls back fully and rethrows the callback's error. Previously it rethrew the operation's error and left the workspace behind, so the next update of that object failed with `UPDATE_IN_PROGRESS`.
- `rename()` throws `FILE_NOT_FOUND` when the source doesn't exist, instead of doing nothing.
- A logical path with a `..` segment, such as `a/../b`, is rejected instead of being normalised. A name that only starts with two dots, such as `..notes.txt`, is now accepted.
- When a storage root's layout extension `config.json` has no `extensionName`, the layout named in `ocfl_layout.json` is used. Previously the storage loaded with no layout.
