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
| `UNSUPPORTED_LAYOUT`          | A storage root's `ocfl_layout.json` names a layout this library doesn't support, and no layout is configured                 |
| `LAYOUT_MISMATCH`             | A configured layout's name or parameters differ from the layout the storage root declares                                    |
| `INVALID_LOGICAL_PATH`        | A logical path is absolute or has a `..` segment, such as `a/../b` or `..\b`                                                 |
| `FILE_NOT_FOUND`              | A lazy file's content isn't in the object, or `copy()` or `rename()` names a source the object doesn't contain               |
| `FILE_EXISTS`                 | `copy()`, `rename()` or `move()` names a target that exists; see [Other behaviour changes](#other-behaviour-changes)         |
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
| E070 | A configured layout meets an `ocfl_layout.json` with no readable `extension`         |
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

## Deprecated methods removed

| Removed                                     | Use instead        |
| ------------------------------------------- | ------------------ |
| `OcflObjectFile.asBuffer()`                 | `buffer()`         |
| `OcflObjectFile.asString()`                 | `text()`           |
| `OcflObjectFile.asStream()`                 | `stream()`         |
| `OcflObjectTransaction.createWriteStream()` | `createWritable()` |
| `OcflStore.createReadStream()`              | `createReadable()` |
| `OcflStore.createWriteStream()`             | `createWritable()` |

The `OcflObjectFile` replacements behave the same as the methods they replace. `OcflObjectTransaction.createWriteStream()` only ever threw `Not Implemented`.

The `OcflStore` methods, including the `OcflFsStore` overrides, returned Node.js streams, but `createReadable()` and `createWritable()` return web streams. Code that needs a Node.js stream can convert them:

```ts
import { Readable, Writable } from 'node:stream';

const readable = Readable.fromWeb(await store.createReadable(filePath));
const writable = Writable.fromWeb(await store.createWritable(filePath));
```

The converted readable emits `Buffer`s even if `createReadable()` was given an encoding. To get strings, pass the encoding to `fromWeb`: `Readable.fromWeb(stream, { encoding: 'utf8' })`.

A custom `OcflStore` should drop any overrides of the removed methods and implement `createReadable()` and `createWritable()`. `createWritable()` has to create any missing parent directories, because the transaction doesn't.

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

## Updates remove only what they created

**Warning for earlier versions:** an object created with `ocfl.object({ root })` and no `workspace` could lose every version when an update ended without committing: an updater that threw, unfinished operations, a `rollback()`, or an update with no changes. With a `workspace`, a failed or successful update removed the whole directory, including anything else in it. Objects from `storage.object()` get their own workspace, so they kept their versions. Upgrade before running further updates on objects with no workspace, and check for a shared or pre-populated workspace. Objects already deleted can't be recovered.

An update now removes only what it created:

- A failed update removes the version directory it was building, so an existing object is left as it was. This includes a commit that fails partway.
- A failed first version also removes the conformance declaration it wrote, and the object root if the update created it.
- A workspace directory is removed only when it's left empty.

A custom `OcflStore` inherits the new `removeIfEmpty()`, which uses `readdir()`. Override it if the backend can check and remove in one atomic step.

Starting an update while another update of the same version is open now throws `UPDATE_IN_PROGRESS` straight away. Previously it was detected only once the first update had written a file.

## Concurrent operations in one update

**Warning for earlier versions:** concurrent operations in one update could write content files that the manifest doesn't list, which is invalid OCFL ([E023](https://ocfl.io/1.1/spec/#E023)). The usual cause is importing a directory containing two files with the same content, even with no concurrency in your own code, because `import()` reads a directory's files concurrently. Concurrent `t.write()` calls could leave the same files, and calls to one logical path could also store a manifest entry for the wrong content or delete the only stored copy. To check an existing object, compare the files in each version's content directory with its manifest. This library doesn't repair affected objects.

Operations called concurrently in one update, such as with `Promise.all`, now give the same result as awaiting them one after another in the order they were called:

- A stream from `createWritable()` takes its place in that order once its queued writes finish and it closes, and doesn't hold up other operations while it's open.
- Each operation waits for the ones called before it. A stream passed to `write()` that's still waiting for input holds up later operations, so finish it before awaiting one of them.
- A failed operation rejects its own promise and leaves nothing behind. Later operations carry on, so a later write of the same content stores it.
- Every operation has to be awaited. `copy()` and `reinstate()` calls left unawaited used to take effect, but now count as unfinished operations and roll back the update.

## Replacing a file within one update

**Warning for earlier versions:** replacing a file more than once in one update, or writing identical content to it again as a stream, may have damaged existing objects. A logical path could read another file's content, or fail to read at all, and content shared with another logical path could be lost. The manifest and fixity block could also keep entries for content that was replaced. To check an existing object, compare each file's content with its digest in the manifest, for example with a dedicated OCFL validator. This library doesn't detect or repair affected objects.

When a logical path is replaced within the update that added its content:

- Content no other logical path uses is removed, along with its manifest and fixity entries.
- Content another logical path still uses moves to that path's content path, and its manifest and fixity entries follow it.
- Writing content identical to what's stored leaves the stored file in place.

Content from earlier versions is never changed.

## Renaming or removing a file within one update

**Warning for earlier versions:** renaming or removing a file added in the same update may have damaged existing objects. After a rename the manifest could list a file that isn't on disk, so the file couldn't be read, and a removal could delete content another logical path still used or leave a manifest entry for a file that's gone. To check an existing object, compare the files in each version's content directory with its manifest, and each file's content with its digest in the manifest, for example with a dedicated OCFL validator. This library doesn't detect or repair affected objects.

For content stored by the update in progress:

- `rename()` and `move()` move the file to the new logical path's content path, and its manifest and fixity entries follow it. If the content is stored at another logical path's content path, no file moves.
- `remove()` follows the rules for [replacing a file](#replacing-a-file-within-one-update): content another logical path still uses moves to that path's content path, and content nothing uses is removed along with its manifest and fixity entries.
- Directories are handled file by file, so one can mix committed and new files.

Renaming or removing a file from an earlier version still changes only the logical path.

## Other behaviour changes

- Looking up a file in a version that doesn't exist returns `undefined` (or `0` from `count()`) instead of throwing.
- `'latest'` now works as a version name in `getFile()`, the `fileBy*()` methods and the inventory methods that take a version. It previously matched nothing, and `fileByDigest()` and `fileByContentPath()` threw a `TypeError`.
- An empty-string version is now always a version that doesn't exist. `inventory.versionState('')`, `inventory.files('')` and reading a lazy file looked up by logical path used to mean the head version, and `fileByDigest(digest, '')` and `fileByContentPath(path, '')` used to search every version.
- `object.import()` no longer empties the array of sources passed to it.
- Importing a directory fails if any of its files fails. Previously the other files were committed and the failures were dropped.
- An update that leaves a stream from `createWritable()` open now rolls back and rejects with "Unfinished operations detected" instead of never settling.
- When an `update()` callback throws after one of its operations failed, the update now rolls back fully and rethrows the callback's error. Previously it rethrew the operation's error and left the workspace behind, so the next update of that object failed with `UPDATE_IN_PROGRESS`.
- `rename()` throws `FILE_NOT_FOUND` when the source doesn't exist, instead of doing nothing.
- **Breaking:** `rename()`, `move()` and `copy()` throw `FILE_EXISTS` when the target exists, even with identical content or when the target is the source. A target exists if it's a file, if it's a directory with anything in it (directories are never merged), or if it's inside a file. When they throw, nothing has changed. `rename()` and `move()` used to replace the target, and `copy()` onto an existing target wrote an invalid object. To replace a target, remove it first in the same update, then copy or rename onto it.
- A logical path with a `..` segment, such as `a/../b`, is rejected instead of being normalised. A name that only starts with two dots, such as `..notes.txt`, is now accepted.
- When a storage root's layout extension `config.json` has no `extensionName`, the layout named in `ocfl_layout.json` is used. Previously the storage loaded with no layout.
- Once an existing object's root inventory has been read, by `load()`, `refresh()`, `update()` or any other method that reads it, `object.ocflVersion` is the version that object declares. It used to report the configured version or the library default, so a 1.0 object in a 1.1 storage root reported 1.1. A configured version only applies when an object is created, and one that differs from an existing object is ignored without an error.
- `load()` keeps a layout passed in the storage config, instead of always replacing it with the root's. The configured layout is used when the root has no `ocfl_layout.json` or names a layout this library doesn't implement, so a custom `OcflStorageLayout` can read such a root. If the root names a supported layout with a different name or parameters, `load()` throws `LAYOUT_MISMATCH`. If the file exists but has no readable `extension`, the configured layout can't be checked, so `load()` throws `E070`.
