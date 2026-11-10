# ocfl-js - An OCFL implementation in Node.js

TypeScript library for creating and manipulating Oxford Common File Layout (OCFL) storage and objects in Node.js.
It is published as one package, `@ocfl/ocfl-fs`, which stores OCFL storage roots and their objects on a locally attached filesystem.

## Installation

Install the library:

```bash
pnpm add @ocfl/ocfl-fs
```

The package is an ES module with bundled TypeScript types and requires Node.js 22.12 or later.

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

Use the `storage` instance to create an object and import files:

```js
let o = storage.object('test-object');

// import from one directory
await o.import('/var/data/dir1');

// import from multiple directories
await o.import(['/var/data/dir2', '/var/data/dir3', '/var/data/dir4']);

// import from multiple files and directories to specific logical paths
// use an array of [source, target] where source is the path to source file or directory
// and target is the logical path of the file in the object.
// To put files under a source directory in the root of object, set target to empty string ('')
await o.import([
  ['/var/data/file1', 'test1/file1'],
  ['/var/data2/file1', 'test2/file1'],
  ['/var/data2/dir1', 'test2/dir1'],
  ['/var/data2/dir2', ''],
]);
```

OCFL objects inside the OCFL storage can be iterated with `for ... of` construct:

```js
for await (const obj of repo) {
  console.log(await obj.count());
}
```


### Object

The OCFL Object can be instantiated by the storage root as described above. It can also be used directly without
the storage root. For example, if you want to manipulate an ocfl object directory that is not associated with a storage layout.

To create a new object or read an existing object that is not part of any storage:

```js
const object = ocfl.object({ root: '/var/data/myocflobject' });
```

Add a content to the object from a directory in the local file system. This will create a new version `v1`.

```js
object.import('/testdata');
```

Add multiple files from different sources as one transaction. All changes will be saved as one new version `v2`).

```js
await object.update(async (t) => {
  // create a new text file test.txt
  await t.write('test.txt', 'abc');
  // add a file or folder '/home/john/data/b' to 'data/b'
  await t.import('/home/john/data/b', 'data/b');
});
```

Operations called concurrently in one transaction, such as with `Promise.all`, give the same result as awaiting them one after another in the order they were called. A stream from `t.createWritable()` takes its place in that order once its queued writes finish and it closes.

List all existing files in the object

```js
for await (let f of await object.files()) {
  // f is the logical path of the file
  let fileContent = await f.text();
}
```

## Extensions

This library implements these storage layouts from the [OCFL Community Extensions](https://github.com/OCFL/extensions):

- `0002-flat-direct-storage-layout`
- `0003-hash-and-id-n-tuple-storage-layout`
- `0004-hashed-n-tuple-storage-layout`

It also includes `000N-path-direct-storage-layout`, which isn't a community extension. Loading a storage root that declares any other layout throws `UNSUPPORTED_LAYOUT`.

Storage layouts and digest algorithms are a fixed, built-in set, and there's no plugin API. If you need another one, send a pull request to this repository. [ADR 0001](docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md) explains why.

## Development

Clone the Git repo:

```bash
git clone https://github.com/Language-Research-Technology/ocfl-js
```

The package lives at the repository root. Development needs Node.js 22.18 or later. Install the dependencies:

```bash
cd ocfl-js
pnpm install
```

## Releasing

See [RELEASING.md](RELEASING.md).
