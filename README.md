# ocfl-js - An OCFL implementation in Node.js

`@ocfl/ocfl-fs` is a TypeScript library for keeping versioned digital objects under the [Oxford Common File Layout (OCFL)](https://ocfl.io/) on a local file system. It reads and writes storage roots and the OCFL objects in them.

**Documentation: <https://language-research-technology.github.io/ocfl-js/>**

## Installation

```bash
pnpm add @ocfl/ocfl-fs
```

It needs Node.js 22.12 or later, and is an ES module with its own types. It's supported and tested on Linux only, on a case-sensitive file system; WSL works, macOS and Windows aren't supported.

Upgrading from 0.4? See [Migrating from 0.4](https://language-research-technology.github.io/ocfl-js/guides/migrating-from-0-4/).

## Example

Create a storage root, deposit an object, add a version and read it back:

<!-- example: website/src/examples/readme/quick-start.ts -->

```ts
import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('/srv/ocfl', {
  layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
});

const object = await root.create('greeting', { message: 'First version', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('hello.txt', 'Hello, world');
});

const updated = await object.update({ message: 'Add a note', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('notes/today.txt', 'Recorded in the field');
});

for (const [path, file] of updated.head.files) {
  console.log(path, await file.text());
}
```

The [documentation site](https://language-research-technology.github.io/ocfl-js/) has guides to getting started, updating objects, concurrent writers and errors, and the full API reference. To see whether the library fits what you're building, read [Use cases and best practices](https://language-research-technology.github.io/ocfl-js/guides/use-cases/).

## It doesn't validate

The library doesn't validate OCFL objects or storage roots against the OCFL specification. It reads and writes them; it doesn't tell you whether they conform. To check objects that another tool wrote, use an OCFL validator. See [It doesn't validate](https://language-research-technology.github.io/ocfl-js/#it-doesnt-validate) on the overview for what the library does check, and why.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, run the checks and send a pull request. To report a security vulnerability, see [SECURITY.md](SECURITY.md). For releases, see [RELEASING.md](RELEASING.md).
