# ocfl-js - An OCFL implementation in Node.js

TypeScript library for creating and manipulating Oxford Common File Layout (OCFL) storage and objects in Node.js.
It is published as one package, `@ocfl/ocfl-fs`, which stores OCFL storage roots and their objects on a locally attached filesystem.

## Installation

Install the library:

```bash
pnpm add @ocfl/ocfl-fs
```

The package is an ES module with bundled TypeScript types and requires Node.js 22.12 or later.

The library is supported and tested on Linux only, and the filesystem must be case-sensitive. macOS isn't supported, and case-insensitive filesystems are untested. Windows isn't supported, but WSL is, because it runs Linux.

Upgrading from 0.4? See [Migrating from 0.4](docs/migrating-from-0.4.md).

## Usage

### Storage

Import the module and then create a new Storage instance with the right config. For example:

```js
import ocfl from '@ocfl/ocfl-fs';
const storage = ocfl.storage({ root: '/var/data/myocfl' });
```

Before any OCFL object can be created in the storage, either the `create` or `load` methods must be be called first.
Alternatively, use the `createStorage` and `loadStorage` methods to create a new storage or load an existing storage as follows:

```js
let storage;
let config = { root: '/var/data/myocfl' };
try {
  storage = await ocfl.createStorage(config);
} catch (error) {
  try {
    storage = await ocfl.loadStorage(config);
  } catch (error) {
    console.error('invalid storage root');
  }
}
// Do something with the storage here
```

To choose a different storage layout, pass its official extension name, or a config object to set its parameters:

```js
// Use the official extension name
storage = ocfl.createStorage({ root: '/var/data/myocfl', layout: '0002-flat-direct-storage-layout' });

// Use the official extension name and specify parameters
storage = ocfl.createStorage({
  root: '/var/data/myocfl',
  layout: {
    extensionName: '0003-hash-and-id-n-tuple-storage-layout',
    tupleSize: 1,
  },
});
```

To include a human-readable copy of the OCFL spec in a new storage root, pass `ocflSpecText` to `create`:

```js
await ocfl.storage({ root: '/var/data/myocfl' }).create({ ocflSpecText: true });
```

An update assembles its new version in the storage root's workspace, `extensions/ocfl-js-workspace`, and then renames it into the object, so a reader never sees a partial version. The workspace is always inside the storage root, so the whole storage root must be on one filesystem. `create` documents the workspace in `ocfl-js-workspace.md` at the top of the storage root.

Use the `storage` instance to create an object and import files:

```js
let o = storage.object('test-object');

// the directory's contents go at the object root
await o.import('/var/data/dir1');

// record who made the version and why
await o.import('/var/data/dir1', { message: 'Nightly sync', user: { name: 'importer' } });

// put the contents under a logical path, and replace everything in the previous version
await o.import('/var/data/dir2', 'dir2', { mode: 'REPLACE' });

// several sources as one version; a file without a target keeps its own name
await o.import([
  { source: '/var/data/file1', target: 'test1/file1' },
  { source: '/var/data2/dir1', target: 'test2/dir1' },
  { source: '/var/data2/readme.txt' },
]);
```

Each `import()` creates one version. The target is the logical path the source becomes. Without one, a directory's contents go at the object root and a file keeps its own name there. Everything under a directory is imported, including hidden files, and a symlink makes the import fail.

A new version starts from the previous version's files in `'MERGE'` mode, the default, so anything not imported carries over. In `'REPLACE'` mode it starts empty, so it holds only what this update adds. Earlier versions, and the manifest of all the content they hold, are kept in both modes.

List the objects in a storage root with `objects()`, and delete one with `remove(id)`, on the storage root from `openStorageRoot()`:

```js
import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/var/data/myocfl');
for await (const object of root.objects()) {
  if (object instanceof OcflError) {
    // an object that can't be opened; the listing carries on
    console.warn(object.message);
    continue;
  }
  console.log(object.id, object.head.files.size);
}

await root.remove('test-object');
```

Check that an object's stored files still match the digests in its inventory with `checkFixity()`, on an object from `open(id)` or `objects()`. It reads every stored file again and returns one entry for each that has changed or is missing, so an empty list means the object is intact:

```js
const object = await root.open('test-object');
for (const { problem, contentPath, expected, actual } of await object.checkFixity()) {
  // problem is 'changed' or 'missing'; contentPath is relative to the object, such as v1/content/audio/1.wav
  console.warn(problem, contentPath, expected, actual);
}
```

It doesn't look for files that aren't in the inventory, and doesn't read the inventory's `fixity` block. A file system error such as `EACCES` is thrown, not reported as a problem.

### Object

An OCFL Object is always opened through its storage root, by its id, or by its path relative to the storage root:

```js
const object = storage.object('test-object');
const objectAtPath = storage.object({ root: 'ab/cd/another-object' });
```

Add a content to the object from a directory in the local file system. This will create a new version `v1`.

```js
object.import('/testdata');
```

Make several changes as one transaction. All changes are saved as one new version `v2`, with the message and user given:

```js
await object.update(
  async (t) => {
    // create a new text file test.txt
    await t.write('test.txt', 'abc');
    // add the file or directory '/home/john/data/b' as 'data/b'
    await t.import('/home/john/data/b', 'data/b');
  },
  { message: 'Add b', user: { name: 'john' } },
);
```

`t.write()` takes a string (stored as UTF-8), a `Buffer` or other typed array, a `DataView`, an `ArrayBuffer`, a `Blob` or `File`, or any async iterable of bytes or strings, such as `fs.createReadStream()`, a web `ReadableStream` or an async generator. Decode base64 or hex yourself first, e.g. `t.write('a.bin', Buffer.from(text, 'base64'))`.

Operations called concurrently in one transaction, such as with `Promise.all`, give the same result as awaiting them one after another in the order they were called.

List all existing files in the object

```js
for await (let f of await object.files()) {
  // f is the logical path of the file
  let fileContent = await f.text();
}
```

### Symbolic links

The library does not resolve symbolic links: a link inside a storage root or object is followed. OCFL forbids links in objects (E090), so keep write access to the storage root limited to trusted processes.

## Extensions

This library implements these storage layouts from the [OCFL Community Extensions](https://github.com/OCFL/extensions):

- `0002-flat-direct-storage-layout`
- `0003-hash-and-id-n-tuple-storage-layout`
- `0004-hashed-n-tuple-storage-layout`

It also includes `000N-path-direct-storage-layout`, which isn't a community extension. Loading a storage root that declares any other layout throws `UNSUPPORTED_LAYOUT`.

Storage layouts and digest algorithms are a fixed, built-in set, and there's no plugin API. If you need another one, send a pull request to this repository. [ADR 0001](docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md) explains why.

### Mutable head (extension 0005)

The library doesn't support [`0005-mutable-head`](https://ocfl.github.io/extensions/0005-mutable-head.html). Another tool can leave an object with an active mutable head, which is a head inventory at `extensions/0005-mutable-head/head/inventory.json`. For such an object:

- `update()` and `import()` throw `MUTABLE_HEAD_ACTIVE` and write nothing. The extension forbids new versions while a head is active, because they would invalidate the head's content.
- Reads ignore the head. They show the versions in the root inventory, which may be older than the head.

If you need support for this extension, send a pull request.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, run the checks and send a pull request. To report a security vulnerability, see [SECURITY.md](SECURITY.md).

## Releasing

See [RELEASING.md](RELEASING.md).
