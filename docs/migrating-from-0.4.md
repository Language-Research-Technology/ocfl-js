# Migrating from 0.4

This release converts `@ocfl/ocfl-fs` to TypeScript, ships it as an ES module with type declarations, and tightens how it handles invalid input. Most code that uses `@ocfl/ocfl-fs` through its default export keeps working once Node.js is upgraded. The sections below cover what may need changing.

## Import everything from `@ocfl/ocfl-fs`

`@ocfl/ocfl-fs` is now the only package you need. It exports everything from `@ocfl/ocfl` that's still part of the API, and [API removed before 1.0](#api-removed-before-10) lists what isn't.

You must remove `@ocfl/ocfl` from your dependencies. `@ocfl/ocfl-fs` no longer depends on it, so keeping it installs a second, separate copy of the library, and nothing warns you. Classes from the two copies are different: `instanceof OcflError` is false for an error thrown by `@ocfl/ocfl-fs` if `OcflError` came from `@ocfl/ocfl`.

After removing it, change the package name in your imports:

```diff
- import { OcflError, type OcflStorage } from '@ocfl/ocfl';
+ import { OcflError, type OcflStorage } from '@ocfl/ocfl-fs';
```

## Node.js 22.12 or later

`@ocfl/ocfl-fs` now requires Node.js 22.12 or later (previously 18). Digests are computed with `node:crypto` and `node:zlib`, and `zlib.crc32` was added in Node.js 22.2.

## ES modules

The package is ESM-only and publishes compiled code from `dist/`.

- **CommonJS** callers can still `require()` the package, because Node.js 22.12 supports `require()` of ES modules:

  ```js
  const ocfl = require('@ocfl/ocfl-fs');
  const storage = ocfl.storage({ root: '/var/data/myocfl' });
  ```

- **If you used the default export of `@ocfl/ocfl`,** use named imports or a namespace import instead:

  ```diff
  - import ocfl from '@ocfl/ocfl';
  + import { storage } from '@ocfl/ocfl-fs';
  + // or
  + import * as ocfl from '@ocfl/ocfl-fs';
  ```

  `@ocfl/ocfl-fs` keeps its default export (`import ocfl from '@ocfl/ocfl-fs'`).

- **Only the package root can be imported.** `index.mjs` and `lib/` no longer exist.

## TypeScript

The package now declares its own types, so delete any hand-written module declarations for `@ocfl/ocfl` or `@ocfl/ocfl-fs`.

The declarations show where a value can be missing, so code that assumed otherwise may no longer compile. The most common cases:

| API                                                 | Now returns                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `object.getInventory()`                             | `Promise<OcflObjectInventory \| undefined>`, `undefined` when the object has no inventory yet                |
| `object.inventory`                                  | `OcflObjectInventory \| undefined` until the object is loaded                                                |
| `object.getFile()`                                  | `undefined` when the object has no such file (see [Errors for missing objects](#errors-for-missing-objects)) |
| `object.id`                                         | `string \| undefined`                                                                                        |
| `inventory.getDigest()`, `inventory.versionState()` | `undefined` for an unknown logical path or version                                                           |
| `file.size`, `file.lastModified`                    | `number \| undefined`; set only when the object was loaded with `{ filesMetadata: true }`                    |

Optional config properties (`OcflStorageConfig`, commit options) accept an explicit `undefined`, so they work with `exactOptionalPropertyTypes`.

`readFile()` on `OcflObject` is typed `Promise<string>` when given an encoding and `Promise<Uint8Array>` otherwise. An encoding has to be a `BufferEncoding`, so a value typed `string` no longer compiles: narrow it or cast it first. When the compiler can't tell whether there's an encoding, as with a value typed `BufferEncoding | undefined`, the result is typed `Promise<string | Uint8Array>`. `null` is no longer accepted as the options argument, and an options object declared as an `interface` has to be spread or redeclared as a `type`. `file.buffer()` is typed for bytes only and doesn't accept an encoding, so use `file.text(encoding)` for a string.

## Option values are matched exactly

Option values used to be matched case-insensitively. They now have to match exactly:

| Option                                              | Accepted values                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `digestAlgorithm` for objects and storage           | `'sha256'`, `'sha512'`                                                                          |
| `digestAlgorithm` for storage layouts 0003 and 0004 | `'md5'`, `'sha1'`, `'sha256'`, `'sha512'`, `'sha512/256'`, `'blake2b-512'`, `'crc32'`, `'size'` |
| `update()` / `import()` mode                        | `'MERGE'`, `'REPLACE'`                                                                          |

For example, `digestAlgorithm: 'SHA512'` and `update(fn, { mode: 'replace' })` now throw. A layout configured with `digestAlgorithm: 'MD5'` used to pass validation and then fail on the first `map()`. It is now rejected when the layout is created.

## Layout parameters are checked

A layout parameter of the wrong type or out of range used to be accepted, and the layout then mapped objects to the wrong paths. It now throws `INVALID_LAYOUT_CONFIG` when the layout is created, whether the parameter comes from the `layout` option, `storageLayout()` or a storage root's `extensions/<layout>/config.json`. An error from `config.json` names that file.

| Layout     | Parameter                     | Accepted values                                       |
| ---------- | ----------------------------- | ----------------------------------------------------- |
| 0003, 0004 | `tupleSize`, `numberOfTuples` | Integers from 0 to 32; if either is 0, both must be   |
| 0004       | `shortObjectRoot`             | A boolean                                             |
| 000N       | `omitScheme`                  | A boolean                                             |
| 000N       | `suffix`                      | A string                                              |
| 000N       | `replace`                     | An array of `[pattern, replacement]` pairs of strings |

These limits come from the 0003 and 0004 extensions. A storage root whose `config.json` sets `tupleSize` or `numberOfTuples` above 32 no longer loads.

A 000N `replace` pattern can no longer be a `RegExp`. `config.json` can only hold JSON values, so a `RegExp` pattern was written as `{}` and lost. Each string pattern replaces its first match. A storage root whose `config.json` has a `{}` pattern no longer loads: write the pattern there as a string.

## Digest algorithms

- `blake2b-160`, `blake2b-256` and `blake2b-384` are no longer supported, because `node:crypto` doesn't provide them. `blake2b-512` is still supported.
- `OcflDigest.FIXITY` has been removed.
- Digest algorithms are a fixed, built-in set that needs no setup. `OcflDigest` and hasher registration have been removed.

## Error classes and codes

Errors a client is expected to handle are now an `OcflError` with a string `code`. Check `error.code` rather than matching on the message: messages aren't part of the API and may change. `OcflError`, its subclasses `ValidationError`, `ObjectNotFoundError` and `ObjectNotLoadedError`, and the `OcflErrorCode` union are exported from `@ocfl/ocfl-fs`:

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

`instanceof OcflError` only works when your app has one copy of the library, so it depends on [removing `@ocfl/ocfl`](#import-everything-from-ocflocfl-fs). Checking `error.code` works across copies.

| Code                          | Thrown when                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OBJECT_NOT_FOUND`            | The object doesn't exist; thrown as an `ObjectNotFoundError` (see [Errors for missing objects](#errors-for-missing-objects)) |
| `OBJECT_NOT_LOADED`           | `getFile()` is called before the inventory has been read; thrown as an `ObjectNotLoadedError`                                |
| `UPDATE_IN_PROGRESS`          | An update finds uncommitted changes, because another process is updating the object or an earlier update failed              |
| `DIRECTORY_NOT_EMPTY`         | An object or storage root is created in a non-empty directory                                                                |
| `ID_INCOMPATIBLE_WITH_LAYOUT` | The storage layout can't map the object id, or the id or `root` maps to the storage root, outside it, or into `extensions`   |
| `UNSUPPORTED_LAYOUT`          | `layout` isn't a supported name or config, or a root's `ocfl_layout.json` names an unsupported layout                        |
| `INVALID_LAYOUT_CONFIG`       | A layout rejects its parameters, or a root's layout extension `config.json` isn't a JSON object or names another layout      |
| `INVALID_LOGICAL_PATH`        | A logical path is absolute or has a `..` segment, such as `a/../b` or `..\b`, or a path to write or remove is empty          |
| `INVALID_PATH`                | A path given to `object.readFile()`, `stat()` or `createReadable()` is absolute or leaves the object root                    |
| `FILE_NOT_FOUND`              | A lazy file's content isn't in the object, or `copy()`, `rename()`, `remove()` or `reinstate()` names a missing path         |
| `FILE_EXISTS`                 | `copy()` or `rename()` would put a directory where there are files without `merge`, or make a path a file and a directory    |
| `FILE_EXISTS`                 | Two sources of one `object.import()` produce the same logical path, or one inside a file                                     |
| `FILE_EXISTS`                 | A written, imported or reinstated file would be inside a file, or would be an existing directory                             |
| `UNSUPPORTED_FILE_TYPE`       | An import source is, or contains, something other than a regular file or directory, such as a symlink                        |
| `SOURCE_CHANGED`              | A file changed while it was being imported                                                                                   |
| `MUTABLE_HEAD_ACTIVE`         | An update or import finds an active mutable head (extension 0005); see [Other behaviour changes](#other-behaviour-changes)   |
| `NOT_AN_OBJECT`               | `storage.remove()` finds something with no OCFL object declaration at the object's path, and deletes nothing                 |
| `CROSS_FILESYSTEM_MOVE`       | An update can't rename its new version into the object, because part of the storage root is on another filesystem            |
| `VERSION_LIMIT_REACHED`       | An update or import finds zero-padded version names used up: the next must still start with a zero (E011), so `v09` is last  |
| `E007`, `E036`, …             | The content violates the OCFL spec; see below                                                                                |

Other errors, such as invalid configuration or arguments, are programming mistakes and remain a plain `Error` or `TypeError`. Invalid layout parameters are the exception: they throw `INVALID_LAYOUT_CONFIG`, because a storage root's `config.json` can hold them too.

An import checks its targets and walks its sources before reading any file, and throws `INVALID_LOGICAL_PATH`, `UNSUPPORTED_FILE_TYPE` or `FILE_EXISTS` directly. If a file then fails to import, it throws the error of the first file that failed, as it is: an `OcflError` such as `SOURCE_CHANGED`, or the file system's error. An import that fails adds none of its files, so an update that catches the error and carries on commits nothing of that import.

## Errors for invalid OCFL content

Spec violations now throw a `ValidationError`, an `OcflError` whose `code` is the OCFL validation code. It also carries a `description` and a `path`. The messages have changed from earlier versions.

| Code | Raised when                                                                          |
| ---- | ------------------------------------------------------------------------------------ |
| E007 | An object's version declaration has the wrong contents (previously reported as E006) |
| E017 | An inventory's `contentDirectory` contains `/`                                       |
| E018 | An inventory's `contentDirectory` is `.` or `..`                                     |
| E036 | An inventory has no `head`                                                           |
| E040 | An inventory's `head` is empty or isn't one of its versions                          |
| E050 | An inventory's state lists a digest that isn't in its manifest                       |
| E060 | The inventory sidecar digest doesn't match the inventory                             |
| E069 | A storage root has no conformance declaration                                        |
| E070 | A storage root's `ocfl_layout.json` has no string `extension`                        |
| E080 | A storage root's version declaration has the wrong contents                          |
| E082 | An object root is nested inside another object                                       |
| E099 | A manifest content path has a `.`, `..` or empty segment                             |
| E100 | A manifest content path begins or ends with `/`                                      |
| E104 | An inventory version name isn't `v` followed by a version number, such as `v1`       |

E017, E018, E036, E040, E050, E099, E100 and E104 are checked when the inventory is read. A malformed object that used to load, and then failed later with a `TypeError`, now fails in `load()` or `getInventory()`.

Other invalid input that used to cause a `TypeError` now throws a descriptive error:

- an unsupported storage layout or extension name
- calling `count()` or `files()` on an object that has no inventory
- calling `storage.object()` with neither an id nor a root

## Validation methods removed

The library reads and writes OCFL objects and storage roots, but it isn't a validator. It raises a `ValidationError` only for the codes listed under [Errors for invalid OCFL content](#errors-for-invalid-ocfl-content), and only when it finds the problem while opening, reading or writing an object or storage root.

These stub methods have been removed:

- `OcflObject.validate()` and `OcflObject.verify()`, which only ever threw `Not Implemented`
- `OcflStorageLayout.validate()`, which did nothing

To check an object or storage root against the spec, use a dedicated OCFL validator.

## Deprecated methods removed

| Removed                                     | Use instead |
| ------------------------------------------- | ----------- |
| `OcflObjectFile.asBuffer()`                 | `buffer()`  |
| `OcflObjectFile.asString()`                 | `text()`    |
| `OcflObjectFile.asStream()`                 | `stream()`  |
| `OcflObjectTransaction.createWriteStream()` | `write()`   |

The `OcflObjectFile` replacements behave the same as the methods they replace. `OcflObjectTransaction.createWriteStream()` only ever threw `Not Implemented`.

## Errors for missing objects

`getFile()` used to return `undefined` whether the object wasn't loaded, didn't exist, or didn't contain the file. Only the last case still returns `undefined`, so call `await object.load()` before `getFile()`:

| Case                                           | `getFile()`                   |
| ---------------------------------------------- | ----------------------------- |
| The inventory hasn't been read yet<sup>1</sup> | throws `ObjectNotLoadedError` |
| The object doesn't exist (no inventory)        | throws `ObjectNotFoundError`  |
| The object exists but doesn't contain the file | `undefined`                   |

<sup>1</sup> By `load()`, or by any method that reads the inventory, such as `getInventory()`, `count()`, `files()` or `update()`.

`getFile(..., true)` (lazy) still returns a file instance without a loaded inventory. `count()`, `files()`, and reading the content of a lazy file looked up by logical path or digest, also throw `ObjectNotFoundError` when the object doesn't exist.

Both are `OcflError`s, with codes `OBJECT_NOT_FOUND` and `OBJECT_NOT_LOADED`, and are exported from `@ocfl/ocfl-fs`:

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
  const newPath = storage.object(id).root;
  const oldPath = path.join(path.dirname(newPath), oldName(id));
  if (oldPath !== newPath && existsSync(oldPath)) await rename(oldPath, newPath);
}
```

## Updates remove only what they created

**Warning for earlier versions:** an object created with `ocfl.object({ root })` and no `workspace` could lose every version when an update ended without committing: an updater that threw, unfinished operations, a `rollback()`, or an update with no changes. With a `workspace`, a failed or successful update removed the whole directory, including anything else in it. Objects from `storage.object()` get their own workspace, so they kept their versions. Upgrade before running further updates on objects with no workspace, and check for a shared or pre-populated workspace. Objects already deleted can't be recovered.

An update now removes only what it created:

- A failed update removes the version directory it was building, so an existing object is left as it was. This includes a commit that fails partway.
- A failed first version also removes the conformance declaration it wrote, and the object root if the update created it.
- A workspace directory is removed only when it's left empty, along with any of its parents, up to the storage root, that it leaves empty.

Starting an update while another update of the same version is open now throws `UPDATE_IN_PROGRESS` straight away. Previously it was detected only once the first update had written a file.

## Concurrent operations in one update

**Warning for earlier versions:** concurrent operations in one update could write content files that the manifest doesn't list, which is invalid OCFL ([E023](https://ocfl.io/1.1/spec/#E023)). The usual cause is importing a directory containing two files with the same content, even with no concurrency in your own code, because `import()` reads a directory's files concurrently. Concurrent `t.write()` calls could leave the same files, and calls to one logical path could also store a manifest entry for the wrong content or delete the only stored copy. To check an existing object, compare the files in each version's content directory with its manifest. This library doesn't repair affected objects.

Operations called concurrently in one update, such as with `Promise.all`, now give the same result as awaiting them one after another in the order they were called:

- Each operation waits for the ones called before it. A stream passed to `write()` that's still waiting for input holds up later operations, so finish it before awaiting one of them.
- A failed operation rejects its own promise and leaves nothing behind. Later operations carry on, so a later write of the same content stores it.
- Every operation has to be awaited. `copy()` and `reinstate()` calls left unawaited used to take effect, but now count as unfinished operations and roll back the update.

## Replacing a file within one update

**Warning for earlier versions:** replacing a file more than once in one update, or writing identical content to it again as a stream, may have damaged existing objects. A logical path could read another file's content, or fail to read at all, and content shared with another logical path could be lost. The manifest and fixity block could also keep entries for content that was replaced. To check an existing object, compare each file's content with its digest in the manifest, for example with a dedicated OCFL validator. This library doesn't detect or repair affected objects.

When a logical path is replaced within the update that added its content:

- Content no other logical path uses is removed, along with its manifest entry.
- Content another logical path still uses moves to that path's content path, and its manifest entry follows it.
- Writing content identical to what's stored leaves the stored file in place.

Content from earlier versions is never changed.

## Renaming or removing a file within one update

**Warning for earlier versions:** renaming or removing a file added in the same update may have damaged existing objects. After a rename the manifest could list a file that isn't on disk, so the file couldn't be read, and a removal could delete content another logical path still used or leave a manifest entry for a file that's gone. To check an existing object, compare the files in each version's content directory with its manifest, and each file's content with its digest in the manifest, for example with a dedicated OCFL validator. This library doesn't detect or repair affected objects.

For content stored by the update in progress:

- `rename()` moves the file to the new logical path's content path, and its manifest entry follows it. If the content is stored at another logical path's content path, no file moves. A file it replaces follows the rules for [replacing a file](#replacing-a-file-within-one-update).
- `remove()` follows the rules for [replacing a file](#replacing-a-file-within-one-update): content another logical path still uses moves to that path's content path, and content nothing uses is removed along with its manifest entry.
- Directories are handled file by file, so one can mix committed and new files.

Renaming or removing a file from an earlier version still changes only the logical path.

## Importing and updating

`update()` takes its mode in an options object, which also takes the message and user recorded in the version. A mode passed on its own, as in `update(fn, 'REPLACE')`, throws a `TypeError`:

```ts
await object.update(async (t) => t.write('a.txt', 'a'), { mode: 'REPLACE', message: 'Start again', user: { name: 'importer' } });
```

Without an updater, pass the message and user to `commit()`. Passing them to `update()` without an updater throws a `TypeError`.

`object.import()` takes one source, with an optional target and the same options, or an array of `{ source, target }`:

| Before                                        | Now                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `import('/data/dir', 'REPLACE')`              | `import('/data/dir', { mode: 'REPLACE' })`                            |
| `import(['/data/a', '/data/b'])`              | `import([{ source: '/data/a' }, { source: '/data/b' }])`              |
| `import([['/data/a', 'a'], ['/data/b', '']])` | `import([{ source: '/data/a', target: 'a' }, { source: '/data/b' }])` |

**Warning:** `import('/data/dir', 'REPLACE')` still compiles, and now imports the directory under a logical path named `REPLACE`.

In both `object.import()` and `t.import()`, the target is the logical path the source becomes. Without one, a directory's contents go at the object root and a file keeps its own name there. **Breaking:** a target of `''` throws `INVALID_LOGICAL_PATH`; leave the target out instead. **Breaking:** `t.import('/data/dir')` used to import the directory under `dir/`. Pass the name, as in `t.import('/data/dir', 'dir')`, to keep that.

An import also:

- fails with `UNSUPPORTED_FILE_TYPE` on a symlink or any other file that isn't a regular file or directory. These used to be skipped.
- fails with `FILE_EXISTS`, and creates no version, if two of its sources produce the same logical path, or one imports a file where another imports a directory. Previously one silently replaced the other. Targets are normalised as `copy()` and `rename()` normalise theirs, so `./a.txt` and `a.txt` are the same path. Importing over a file the object has is still an ordinary update, but a file that would be a directory the object has, or inside one of its files, fails with `FILE_EXISTS` before anything is imported.
- fails with `SOURCE_CHANGED` if a file changes while it's being imported, instead of storing the new bytes under the old digest and leaving the object invalid.
- reads at most a fixed number of files at once across all the imports in one update. Deep directory trees used to open enough files at once to fail with `EMFILE`.

## API removed before 1.0

Each public member now corresponds to something the OCFL specification or the library's role as an OCFL client calls for, with one name per operation.

| Removed                                                                                                  | Use instead                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `OcflObject.add()`                                                                                       | `import()`                                                                                                          |
| `OcflObjectTransaction.move()`                                                                           | `rename()`                                                                                                          |
| `OcflObjectTransaction.delete()`                                                                         | `remove()`                                                                                                          |
| `OcflStorage.objects()`                                                                                  | `for await (const object of storage)`                                                                               |
| `OcflStorage.objectRootAbs(id)`                                                                          | `storage.object(id).root`                                                                                           |
| `OcflExtension.p`                                                                                        | `parameters` on the layout from `storageLayout()`, defaults included                                                |
| `OcflStorage.delete(id)`                                                                                 | `storage.remove(id)`; see [Deleting an object](#deleting-an-object)                                                 |
| `OcflStorage.purge(id)`                                                                                  | `storage.remove(id)`; see [Deleting an object](#deleting-an-object)                                                 |
| `OcflStorageImpl`                                                                                        | `OcflStorage`, from `storage()`, `createStorage()` or `loadStorage()`                                               |
| `OcflObjectTransactionImpl`                                                                              | `OcflObjectTransaction`, from `object.update()`                                                                     |
| A class name or layout object as `layout` or in `storageLayout()`                                        | The official extension name or `{ extensionName, ...params }`; see [Choosing a layout](#choosing-a-layout)          |
| Constructing, subclassing or `instanceof` on the public classes                                          | The functions that return them, and the classes as types; see [Public classes are types](#public-classes-are-types) |
| `OcflDigest.digest()`, `digestSync()`, `createStream()`, `createStreamThrough()`, `getHexDigestLength()` | `createHash()` from `node:crypto`, or `crc32()` from `node:zlib`                                                    |
| `OcflDigest.initSync()`                                                                                  | Nothing: the built-in digest algorithms need no initialisation                                                      |
| `OcflDigest.CONTENT`                                                                                     | The values `'sha256'` and `'sha512'`                                                                                |
| `OcflDigest.registerHasherFactory()`                                                                     | Nothing: digest algorithms are a fixed set; to add one, send a pull request to this library                         |
| `OcflDigest.hasAlgorithm()`                                                                              | Nothing: the supported algorithms are listed in [Option values](#option-values-are-matched-exactly)                 |
| `OcflDigest`                                                                                             | Nothing: all its members have gone; see the rows above                                                              |
| The `CommonHasher` and `IDataType` types                                                                 | Nothing: they only described hashers passed to `registerHasherFactory()`                                            |
| `OcflObject.fileByLogicalPath(path, version)`                                                            | `await object.load()` once, then `object.getFile(path, version)`                                                    |
| `OcflObject.fileByDigest(digest, version)`                                                               | `await object.load()` once, then `object.getFile({ digest, version })`                                              |
| `OcflObject.fileByContentPath(path, version)`                                                            | `await object.load()` once, then `object.getFile({ contentPath: path, version })`                                   |
| `OcflExtension.object()`, `OcflExtension.storage()`                                                      | `storageLayout(name)`; see [Layout classes](#layout-classes)                                                        |
| `OcflExtension.forObject`, `OcflExtension.forStorage`, `OcflStorageLayout.forStorage`                    | `storageLayout(name)`; see [Layout classes](#layout-classes)                                                        |
| `OcflExtension.minOcflVersion`                                                                           | Nothing: the library never read it                                                                                  |
| `OcflObjectConfig.extensions`                                                                            | Nothing: the library never read it, so drop the option                                                              |
| The `OcflObject.digestAlgorithm` setter                                                                  | `digestAlgorithm` in the config of a new object                                                                     |
| Assigning to `OcflObject.contentDirectory`                                                               | `contentDirectory` in the config of a new object                                                                    |
| `OcflObjectTransaction.purge()`                                                                          | A new object without the file; see [Removing a file from all versions](#removing-a-file-from-all-versions)          |
| `remove(path, { purge: true })`                                                                          | A new object without the file; see [Removing a file from all versions](#removing-a-file-from-all-versions)          |
| `RemoveOptions`                                                                                          | Nothing: `remove()` takes only a logical path                                                                       |
| `CommitOptions.force`                                                                                    | Nothing: a commit with no changes rolls back                                                                        |
| The `options` argument of `write(path, data, options)`                                                   | Nothing: decode first, e.g. `Buffer.from(text, 'base64')`; strings are written as UTF-8                             |
| `OcflObjectTransaction.createWritable()`                                                                 | `write(path, stream)`, which takes a stream or any async iterable                                                   |
| `OcflObjectInventory.newVersion()`                                                                       | `object.update()`, which creates each new version                                                                   |
| `inventory.isChanged`                                                                                    | `inventory.diffState(version0, version1)`; see [Read-only inventories](#read-only-inventories)                      |
| `inventory.clone()`                                                                                      | `inventory.toJSON()`, which gives a plain copy of the inventory data                                                |
| The `inventory.created`, `message` and `user` setters                                                    | `transaction.commit({ message, user })`; `created` is set when a version is committed                               |
| The `inventory.fixity` setter                                                                            | Nothing: fixity values are no longer written                                                                        |
| The `fixityAlgorithms` option of an object or storage                                                    | Nothing: an existing `fixity` block is kept as it is                                                                |
| The `OcflObjectInventoryMut` type                                                                        | `OcflObjectInventory`                                                                                               |
| `OcflObject.export()`                                                                                    | `object.files(version)` and `file.stream()`; see [Writing a version out](#writing-a-version-out)                    |
| `extensions.DigestAlgorithm`                                                                             | Nothing to replace: to add an algorithm from extension 0009, send a pull request to this library                    |
| The `extensions` namespace, named and on the default export                                              | `storageLayout()`; see [Layout classes](#layout-classes)                                                            |
| `new extensions.HashedNTupleStorageLayout()` and the other layout classes                                | `storageLayout(name)` or `storageLayout({ extensionName, ...params })`; see [Layout classes](#layout-classes)       |
| `OcflExtension`, as a value and as a type                                                                | Nothing: layouts are a fixed set; to add one, send a pull request to this library                                   |
| `OcflStorageLayout` as a value                                                                           | The `OcflStorageLayout` type, from `storageLayout()`; see [Layout classes](#layout-classes)                         |
| `OcflExtension.register()`, `OcflStorageLayout.register()`, `setup()`                                    | Nothing: layouts are a fixed set; to add one, send a pull request to this library                                   |
| `OcflExtension.create()`, `OcflStorageLayout.create()`                                                   | `storageLayout()`, with the layout's `extensionName` in the config                                                  |
| `OcflExtension.class()`, `OcflStorageLayout.class()`                                                     | `storageLayout(name)`, which throws `UNSUPPORTED_LAYOUT` for a layout this library doesn't implement                |
| `OcflExtension.classes`, `OcflStorageLayout.classes`                                                     | The `OcflLayoutName` type, which lists the built-in layouts                                                         |
| `OcflExtension.NAME`, `DESCRIPTION`, and the same statics on the layout classes                          | The official names under [Choosing a layout](#choosing-a-layout); descriptions have no replacement                  |
| A layout object's `description`, `version`, `config` and `set()`                                         | `name` and the read-only `parameters`; set parameters through `storageLayout()`                                     |
| The `ExtensionConstructor` type                                                                          | Nothing: it only described layout subclasses                                                                        |
| `ocfl.StorageLayout`, and the `StorageLayout` export of `@ocfl/ocfl-fs`                                  | `storageLayout()`; see [Layout classes](#layout-classes)                                                            |
| The `StorageLayout` type                                                                                 | The `OcflStorageLayout` type: `name`, read-only `parameters` and `map`                                              |
| The `OcflExtensionConfig` type                                                                           | `OcflLayoutConfig`, which types each layout's parameters                                                            |
| `OcflStorageLayout.layout`                                                                               | `storageLayout()`; see [Layout classes](#layout-classes)                                                            |
| `OcflConstants`                                                                                          | `OCFL_VERSIONS`, on the default API and as a named export of `@ocfl/ocfl-fs`. The other values were internal        |
| The `MultiHasher` type                                                                                   | Nothing: no public signature used it                                                                                |
| `OcflStore`, including `createReadStream()` and `createWriteStream()`                                    | Nothing: the library always uses `node:fs`; see [Filesystem only](#filesystem-only)                                 |
| `OcflFsStore`                                                                                            | Nothing: `storage()`, `createStorage()` and `loadStorage()` use the filesystem directly                             |
| `OcflFsStoreConfig`                                                                                      | Nothing: the only option was `fs`; see [Filesystem only](#filesystem-only)                                          |
| `implementOcfl`                                                                                          | `storage()`, `createStorage()`, `loadStorage()`, `storageLayout()` and `OCFL_VERSIONS`                              |
| The `ListedFile` and `ListOptions` types                                                                 | Nothing: they only described `OcflStore.list()`                                                                     |
| The second argument to `storage()`, `createStorage()` and `loadStorage()`                                | Nothing: put the data in a real directory; see [Filesystem only](#filesystem-only)                                  |
| Members whose names start with `_`, such as `object._inventory` and `transaction._commit()`              | Nothing: they were internal; see [Internal members](#internal-members)                                              |
| `object()` and `OcflObjectConfig`                                                                        | `storage.object(id)` or `storage.object({ root })`; see [Opening an object](#opening-an-object)                     |
| The `workspace` option of `storage()`, `createStorage()` and `loadStorage()`                             | Nothing: updates use the storage root's own workspace; see [Workspace](#workspace)                                  |

### Opening an object

Objects are opened only through their storage root, which supplies the object's OCFL version, workspace and digest settings. `object()` opened one by its path alone, so a new object was always OCFL 1.1, even in a 1.0 storage root, and without a `workspace` its updates wrote straight into the object root.

Open the storage root, then the object by its id, or by its path relative to the storage root:

```diff
- const object = ocfl.object({ root: '/var/data/myocfl/ab/cd/object-1' });
+ const storage = await ocfl.loadStorage({ root: '/var/data/myocfl' });
+ const object = storage.object('object-1');
```

or, by path:

```js
import path from 'node:path';

const storage = await ocfl.loadStorage({ root: '/var/data/myocfl' });
const object = storage.object({ root: path.relative(storage.root, '/var/data/myocfl/ab/cd/object-1') });
```

An object that isn't in any storage root can't be opened with this library. To work with one, create a storage root and move the object into it.

### Workspace

Updates are assembled in the storage root's own workspace, `extensions/ocfl-js-workspace`, and the `workspace` option has been removed. Remove it from your configuration:

```diff
  const storage = await ocfl.loadStorage({
    root: '/opt/storage/ocfl',
-   workspace: '/opt/storage/scratch-ocfl',
  });
```

**Warning for JavaScript callers:** the option isn't checked at runtime, so untyped code that still passes `workspace` has it silently ignored, and updates use `extensions/ocfl-js-workspace` inside the storage root. TypeScript reports it as an unknown property.

A version is published by renaming it from the workspace into the object, which only works within one filesystem. A workspace elsewhere, such as `/tmp`, made each update copy its version into the object instead, so a crash could leave a partial copy inside the object. Now a version is never copied: if a rename crosses filesystems, the update throws `CROSS_FILESYSTEM_MOVE` and leaves the object as it was. Keep the whole storage root on one filesystem.

The workspace directory exists only while an update is running, or after an update was interrupted, when it holds that update's partial version. Delete it once no update is running. `ocfl-js-workspace` isn't a registered OCFL extension, so `create()` writes `ocfl-js-workspace.md` into a new storage root to document it, and a validator may warn about the directory while an update is in progress. After upgrading, and once no update is running, delete any workspace directory you used to pass, and `extensions/workspace` in the storage root, which was the default.

### Filesystem only

The library now stores OCFL on the local filesystem through `node:fs`, and storing it anywhere else isn't supported. `storage()`, `createStorage()` and `loadStorage()` take one configuration argument, and the `{ fs }` option has gone.

**Warning for JavaScript callers:** a second argument isn't checked at runtime, so untyped code that still passes `{ fs }` has it silently ignored and writes to the real filesystem. A `root` meant for [memfs](https://www.npmjs.com/package/memfs) would end up on your disk. TypeScript rejects the second argument, but find and remove any such call in plain JavaScript before upgrading.

If you passed `{ fs }` to test against an in-memory filesystem, point `root` at a temporary directory instead, and remove it afterwards:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ocfl from '@ocfl/ocfl-fs';

const dir = await mkdtemp(path.join(tmpdir(), 'ocfl-'));
const storage = await ocfl.createStorage({ root: path.join(dir, 'root') });
// ...
await rm(dir, { recursive: true, force: true });
```

### Deleting an object

`OcflStorage.remove`, `delete` and `purge` only ever threw. `storage.remove(id)` now deletes an object, without you needing to know the storage layout. It removes the object root and any version a failed update left in the workspace, so a recreated object can be updated. Parent directories left empty are removed too, up to but not including the storage root, so the storage root stays valid. It isn't guarded against a concurrent update of the same object.

It throws, and deletes nothing, when:

- the object doesn't exist (`ObjectNotFoundError`)
- the path holds something with no OCFL object declaration (`NOT_AN_OBJECT`)
- the object's declaration has the wrong contents (`E007`)
- the layout maps the id to the storage root, outside it, or into its `extensions` directory (`ID_INCOMPATIBLE_WITH_LAYOUT`)
- the object's inventory has a different id, or there is no inventory to confirm it, for example because an id such as `a/../b` resolves to another object's path (`ID_INCOMPATIBLE_WITH_LAYOUT`)
- the object's inventory can't be read or is invalid: `storage.remove` rejects with the underlying error, such as a `SyntaxError` for a corrupt `inventory.json` or `ENOENT` for a missing sidecar, and deletes nothing. Such an object has to be deleted by hand
- the object is nested inside another object (`E082`)

### Looking up a file

`getFile()` is the only file lookup. It's synchronous and doesn't read the inventory itself, whereas the `fileBy*()` methods read it for you. Read the inventory once first, or `getFile()` throws `ObjectNotLoadedError`:

```diff
- const file = await object.fileByDigest(digest, 'v1');
+ await object.load();
+ const file = object.getFile({ digest, version: 'v1' });
```

When you look up a file with an object, put `version` in that object. The second argument of `getFile()` applies only to a logical path given as a string.

### Removing a file from all versions

`transaction.purge()` never destroyed anything. Inside `update(callback)` it did nothing, and with `commit({ force: true })` the bytes stayed on disk and in the manifest, leaving the object invalid. OCFL versions are immutable and the OCFL Implementation Notes say purging is not supported directly, so the library no longer offers it.

To remove a file from an object's history, follow the route the Implementation Notes recommend: create a new object without the file, then delete the original.

```ts
const original = storage.object('original-id');
const files = await original.files();

await storage.object('new-id').update(async (transaction) => {
  for (const file of files) {
    if (file.logicalPath !== 'secret.txt') {
      await transaction.write(file.logicalPath!, await file.stream());
    }
  }
});

await storage.remove('original-id');
```

The new object needs its own identifier, because a layout maps each identifier to one path.

This example copies only the head version, so the new object starts with a single version. To keep earlier versions, create one version in the new object for each version of the original, using `files(version)` and leaving out the file.

### Read-only inventories

OCFL versions are immutable, so the inventory you read from an object now only offers reading operations. Its setters changed a cached inventory without touching storage, and they've gone.

`manifest`, `versions`, `version`, `state`, `fixity`, `user` and `versionState()` return read-only types, so code like `inventory.versions.v1.message = 'x'` or `inventory.manifest[digest].push(path)` no longer compiles. This is only enforced at compile time; the data isn't frozen. Passing one of these values to a function that takes a mutable type needs a copy, which `inventory.toJSON()` gives you.

To find out what changed between two versions, use `diffState`. It returns the files in the first version but not the second, then the files in the second but not the first:

```ts
const [added, removed] = inventory.diffState('v2', 'v1');
const changed = Object.keys(added).length > 0 || Object.keys(removed).length > 0;
```

### Writing a version out

`OcflObject.export()` only ever threw `Not Implemented`. To reconstruct a version's state in a directory, read its files with `files(version)` and write each one under its logical path:

```ts
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { LegacyOcflObject } from '@ocfl/ocfl-fs';

async function writeVersion(object: LegacyOcflObject, targetDir: string, version: string) {
  for (const file of await object.files(version)) {
    const target = path.join(targetDir, file.logicalPath!);
    await mkdir(path.dirname(target), { recursive: true });
    const readable = await file.stream();
    await readable.pipeTo(Writable.toWeb(createWriteStream(target)));
  }
}
```

### Layout classes

The layout classes, the `extensions` namespace and the extension registry have gone. Layouts are a fixed, built-in set, so a layout can't be subclassed or registered. To add one, send a pull request to this library.

To map identifiers to paths without a storage root, use `storageLayout()` with the layout's official name, or a config object to set its parameters:

```diff
- const layout = new ocfl.extensions.HashedNTupleStorageLayout();
+ const layout = ocfl.storageLayout('0004-hashed-n-tuple-storage-layout');

- const layout = new ocfl.StorageLayout.PathDirectStorageLayout({ omitScheme: true });
+ const layout = ocfl.storageLayout({ extensionName: '000N-path-direct-storage-layout', omitScheme: true });
```

It returns an `OcflStorageLayout`: its `name`, its read-only `parameters` with the defaults filled in, and `map(id)`. Each layout's `parameters` are typed, and a layout whose kind isn't known until run time is narrowed by `name`:

```diff
- layout.get('tupleSize');
+ ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').parameters.tupleSize; // number
+ if (layout.name === '0004-hashed-n-tuple-storage-layout') layout.parameters.tupleSize;
```

The class names and their official names are listed under [Choosing a layout](#choosing-a-layout).

### Choosing a layout

The `layout` option and `storageLayout()` accept an official extension name, or `{ extensionName, ...params }` to set a layout's parameters. Anything else, including a class name, a layout object, or a config object with no `extensionName`, throws an `OcflError` with code `UNSUPPORTED_LAYOUT`, and TypeScript rejects it. Previously a config object with no `extensionName` silently left the storage root with no layout.

Replace each class name with its official name:

| Class name                     | Official name                               |
| ------------------------------ | ------------------------------------------- |
| `PathDirectStorageLayout`      | `'000N-path-direct-storage-layout'`         |
| `FlatDirectStorageLayout`      | `'0002-flat-direct-storage-layout'`         |
| `HashAndIdNTupleStorageLayout` | `'0003-hash-and-id-n-tuple-storage-layout'` |
| `HashedNTupleStorageLayout`    | `'0004-hashed-n-tuple-storage-layout'`      |

```diff
- ocfl.storage({ root, layout: 'HashedNTupleStorageLayout' });
+ ocfl.storage({ root, layout: '0004-hashed-n-tuple-storage-layout' });
```

If you passed a layout object, pass its name and parameters instead. Those were previously the constructor's arguments:

```diff
- ocfl.storage({ root, layout: new ocfl.extensions.PathDirectStorageLayout({ omitScheme: true }) });
+ ocfl.storage({ root, layout: { extensionName: '000N-path-direct-storage-layout', omitScheme: true } });
```

The names are typed as `OcflLayoutName`, so a value typed `string` no longer compiles: type it as `OcflLayoutName`, or a config object as `OcflLayoutConfig`.

A config object's parameters are typed per layout, using `PathDirectStorageLayoutConfig`, `HashAndIdNTupleStorageLayoutConfig` or `HashedNTupleStorageLayoutConfig`. A parameter the layout doesn't declare, or a value of the wrong type, no longer compiles:

```diff
- ocfl.storageLayout({ extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: '2' });
+ ocfl.storageLayout({ extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 2 });
```

### Layouts 0006 and 0007

`FlatOmitPrefixStorageLayout` (`0006-flat-omit-prefix-storage-layout`) and `NTupleOmitPrefixStorageLayout` (`0007-n-tuple-omit-prefix-storage-layout`) have been removed. They could never map an identifier to a path. Choosing either throws `UNSUPPORTED_LAYOUT`.

Loading a storage root that declares either of them, or any other layout this library doesn't implement, also throws `UNSUPPORTED_LAYOUT`. A configured layout used to be accepted on these roots, so identifiers could resolve to the wrong objects. There's no replacement: to use such a root, contribute the layout to this library.

### Public classes are types

`OcflStorage`, `OcflObjectTransaction`, `OcflObjectInventory` and `OcflObjectFile` are now exported as types only, and so is the object class, under the name `LegacyOcflObject`. The name `OcflObject` now belongs to the object that `root.open()` returns. You can still name them in annotations, using `import type` or `type` in an import, but you can't construct or subclass them. They no longer exist at runtime, so `instanceof OcflStorage` and `class MyStorage extends OcflStorage` stop working. `new OcflStorage()` used to compile and give an object whose methods only threw.

| Type                    | Get one from                                        |
| ----------------------- | --------------------------------------------------- |
| `LegacyOcflObject`      | `storage.object()`                                  |
| `OcflStorage`           | `storage()`, `createStorage()` or `loadStorage()`   |
| `OcflObjectTransaction` | `object.update()`, which passes it to your callback |
| `OcflObjectInventory`   | `object.getInventory()` or `object.inventory`       |
| `OcflObjectFile`        | `object.getFile()` or `object.files()`              |

### Internal members

Members used only inside their own class, such as `object._inventory`, `object._readInventory()`, `transaction._commit()` and `transaction._queue`, are now JavaScript private fields. They're gone from the published types and can't be reached at runtime. `Object.keys()` and `console.log()` or `util.inspect()` of an object or transaction no longer show them, and `JSON.stringify()` of a transaction now gives `{}`. Because a `Proxy` can't reach private fields, calling a method on an object or transaction wrapped in one, such as Vue's `reactive()` or a MobX observable, now throws a `TypeError`. Keep them out of reactive state, for example with Vue's `markRaw()`.

The remaining `_` members, such as `object._setInventory()`, `object._requireInventory()` and `inventory._digest`, are shared between the library's classes. They're no longer in the published types, and neither are `OcflObjectTransaction.create()` and `VersionNumber.fromString()`. They still exist at runtime, but they aren't part of the API and can change in any release. The `OcflObjectTransaction` and `VersionNumber` constructors are private, and `VersionNumber.fromInt()` and the static `VersionNumber.next()` and `VersionNumber.previous()` have been removed; the `next()` and `previous()` methods of a version number remain.

## Other behaviour changes

- Looking up a file in a version that doesn't exist returns `undefined` (or `0` from `count()`) instead of throwing.
- `'latest'` now works as a version name in `getFile()` and the inventory methods that take a version. It previously matched nothing, and looking up a file by digest or content path threw a `TypeError`.
- An empty-string version is now always a version that doesn't exist. `inventory.versionState('')`, `inventory.files('')` and reading a lazy file looked up by logical path used to mean the head version, and looking up a file by digest or content path with an empty version used to search every version.
- `object.import()` no longer empties the array of sources passed to it.
- Importing a directory fails if any of its files fails, with the error of the first file that failed. Previously the other files were committed and the failures were dropped.
- When an `update()` callback throws after one of its operations failed, the update now rolls back fully and rethrows the callback's error. Previously it rethrew the operation's error and left the workspace behind, so the next update of that object failed with `UPDATE_IN_PROGRESS`.
- When an operation fails and its changes to the stored files can't be undone, `update()` throws that operation's own error once the callback returns, so `error.code` is the operation's. Previously it threw a plain `Error` with the operation's error as its `cause`.
- `update()` and `import()` throw `MUTABLE_HEAD_ACTIVE` and write nothing when the object has an active mutable head. Previously they created a new version, which extension 0005 forbids. See [Mutable head](../README.md#mutable-head-extension-0005).
- **Breaking:** `remove()` throws `FILE_NOT_FOUND` when nothing is at the path, instead of doing nothing, and `INVALID_LOGICAL_PATH` for an empty path. Its path is normalised first, so `./raw//1.wav` removes `raw/1.wav`.
- `rename()` throws `FILE_NOT_FOUND` when the source doesn't exist, instead of doing nothing.
- **Breaking:** `rename()` replaces a file at the target, and does nothing when the target is the source. It throws `FILE_EXISTS` for a directory renamed onto a file, or onto a directory with anything in it, unless `{ merge: true }` is given as the third argument: then the directory is moved file by file, replacing files at the same path and keeping the rest. It also throws `FILE_EXISTS` for a file that would be an existing directory or inside an existing file, with or without `merge`. Options that aren't an object, or a `merge` that isn't a boolean, throw a `TypeError`. It throws `INVALID_LOGICAL_PATH` for an empty source or target, and for a target inside the source, such as `rename('raw', 'raw/old')`, which used to succeed. When it throws, nothing has changed. The source is normalised as the target is, so `./a//b.txt` is `a/b.txt`.
- **Breaking:** `copy()` replaces a file at the target, and does nothing when the target is the source. It throws `FILE_EXISTS` for a directory copied onto a file, or onto a directory with anything in it, unless `{ merge: true }` is given as the third argument: then the directory is copied file by file, replacing files at the same path and keeping the rest. It also throws `FILE_EXISTS` for a file that would be an existing directory or inside an existing file, with or without `merge`. Options that aren't an object, or a `merge` that isn't a boolean, throw a `TypeError`. It throws `INVALID_LOGICAL_PATH` for an empty source or target, a source with a `..` segment, and a target inside the source, such as `copy('raw', 'raw/old')`. When it throws, nothing has changed. The source is normalised as the target is, so `./a//b.txt` is `a/b.txt`. `copy()` onto an existing target used to write an invalid object.
- **Breaking:** `write()` and `reinstate()` throw `FILE_EXISTS` for a file that would be inside an existing file, or would be an existing directory with anything in it. When they throw, nothing has changed. `write()` used to write an invalid object, in which one logical path was both a file and a directory, and `reinstate()` used to replace the directory. Writing or reinstating over an existing file still replaces it. To put a file where a directory is, remove the directory first in the same update.
- **Breaking:** `reinstate()` takes a version number instead of a version name, so `reinstate('a.txt', 1)` for `v1` or `v001`, and returns nothing instead of a count. A version that isn't a number, such as `'v1'`, throws a `TypeError`. It throws `FILE_NOT_FOUND` when the version doesn't exist or had nothing at the path, instead of doing nothing. Any committed version can be given, including the latest, which undoes the update's own change to that path; the version being written isn't one, and neither is `'latest'`. Its path is normalised first, and an empty path throws `INVALID_LOGICAL_PATH`. A directory puts back every file that was below it, replacing files at the same paths and keeping the rest.
- `write()` stores a logical path in its normalised form, as `copy()`, `rename()` and `import()` do, so `./a//b.txt` is `a/b.txt`. An empty path, such as `''` or `.`, throws `INVALID_LOGICAL_PATH`.
- A logical path with a `..` segment, such as `a/../b`, is rejected instead of being normalised. A name that only starts with two dots, such as `..notes.txt`, is now accepted.
- **Breaking:** an object id or `root` that maps to the storage root, outside it, or into its `extensions` directory throws `ID_INCOMPATIBLE_WITH_LAYOUT` from `objectRoot()`, `object()`, `has()` and `remove()`, and nothing is written. Previously objects could be written outside the storage root.
- **Breaking:** the path-direct layout rejects an id with a `.` or `..` segment, such as `a/./b`, `../x` or `https://h/a/../b`, with `ID_INCOMPATIBLE_WITH_LAYOUT` instead of normalising it. This includes the encoded forms a URL parser resolves, such as `%2e%2e`, and `\` as a separator. A layout `suffix` with such a segment throws `INVALID_LAYOUT_CONFIG`. The flat-direct layout rejects the ids `.` and `..`.
- **Breaking:** `object.readFile()`, `stat()` and `createReadable()` throw `INVALID_PATH` for an absolute path or one that leaves the object root. Previously an absolute path was read relative to the object root.
- `object.getInventory(version)` returns `undefined` for a version that isn't a version name, such as `v1/content/x` or `..`, without reading a file. Previously it read the `inventory.json` at that path.
- A `contentDirectory` in the storage config that contains `/` or is `.` or `..` makes `storage.object()` throw a `TypeError`. Previously it wrote content outside the version directory.
- When a storage root's layout extension `config.json` has no `extensionName`, the layout named in `ocfl_layout.json` is used. Previously the storage loaded with no layout.
- Once an existing object's root inventory has been read, by `load()`, `refresh()`, `update()` or any other method that reads it, `object.ocflVersion` is the version that object declares. It used to report the configured version or the library default, so a 1.0 object in a 1.1 storage root reported 1.1. A configured version only applies when an object is created, and one that differs from an existing object is ignored without an error.
- Once an existing object's root inventory has been read, `object.digestAlgorithm` and `object.contentDirectory` are the values in that inventory. They used to report the configured values or the library defaults, so a `sha256` object with content directory `data`, loaded with default config, reported `sha512` and `content`. Until the inventory has been read, and for an object that doesn't exist yet, they still report the configured value or default. As with `ocflVersion`, the configured values only apply when an object is created.
- `load()` takes the layout from the storage root's own `ocfl_layout.json`, as before, and ignores a layout passed in the storage config, which is only used by `create()`. If the root has no `ocfl_layout.json`, the storage loads with no layout, as before. If the root names a layout this library doesn't implement, `load()` throws `UNSUPPORTED_LAYOUT`. If the file exists but has no string `extension`, `load()` throws `E070`. If the layout extension `config.json` names a different layout, `load()` throws `INVALID_LAYOUT_CONFIG`. Previously, in each of these three cases, the storage loaded with no layout or with the layout `config.json` named.
- The `ocflVersion` storage option is gone. `create()` makes an OCFL 1.1 storage root, and `load()` takes the version from the root's declaration.
- `load()` throws `UNSUPPORTED_LAYOUT` when `ocfl_layout.json` has an empty `extension`. Previously the storage loaded with no layout, or with the configured one.
- `load()` throws `INVALID_LAYOUT_CONFIG` when the root's layout extension `config.json` isn't a JSON object, or has parameters the layout rejects. Previously it used the layout's default parameters, so objects mapped to the wrong paths. A missing `config.json` still means the defaults.
- When `ocfl_layout.json` or the layout extension `config.json` exists but can't be read, `load()` rejects with the file system error, such as `EACCES`. Previously it treated the file as missing.
