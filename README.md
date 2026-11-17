# @ocfl/ocfl-fs

[![npm (beta)](https://img.shields.io/npm/v/@ocfl/ocfl-fs/beta)](https://www.npmjs.com/package/@ocfl/ocfl-fs)
[![CI](https://github.com/Language-Research-Technology/ocfl-js/actions/workflows/publish.yml/badge.svg?branch=main&event=push)](https://github.com/Language-Research-Technology/ocfl-js/actions/workflows/publish.yml)
[![Licence: GPL-3.0-or-later](https://img.shields.io/npm/l/@ocfl/ocfl-fs)](LICENSE)

`@ocfl/ocfl-fs`, from the ocfl-js repository, is a TypeScript library for keeping versioned digital objects under the [Oxford Common File Layout (OCFL)](https://ocfl.io/) on a local file system. It reads and writes storage roots and the OCFL objects in them.

OCFL is a specification for preserving digital objects on disk for the long term. Each OCFL object is a plain directory that holds every version of its files and an inventory recording them, so it can be read without the software that wrote it. This library is for applications, such as repositories and archives, that keep their objects in an OCFL storage root.

**Documentation: <https://language-research-technology.github.io/ocfl-js/>**

## Installation

```bash
pnpm add @ocfl/ocfl-fs@beta
```

Until 1.0 is released, `@beta` is needed: without it you get 0.4, which has a different API.

It needs Node.js 22.12 or later, and is an ES module with its own types; with TypeScript, it needs `@types/node`. It supports the Node.js versions that still get updates; when a Node.js version stops getting updates, a minor release can drop it.

It's supported on Linux only, on a case-sensitive file system with hard links; WSL works, macOS and Windows aren't supported. It's designed for local file systems and NFS, but CI tests only on a local file system and simulates NFS's lost replies; see [Sharing a storage root over NFS](https://language-research-technology.github.io/ocfl-js/guides/concurrent-writers/#sharing-a-storage-root-over-nfs).

Upgrading from 0.x? See [Upgrading from 0.x](https://language-research-technology.github.io/ocfl-js/guides/upgrading-from-0-x/).

## Example

Create a storage root, deposit an object, add a version and read it back:

<!-- example: website/src/examples/readme/quick-start.ts -->

```ts
import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('ocfl-quick-start', {
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

The example creates its storage root in `ocfl-quick-start`, so delete that directory before running it again; otherwise it fails with [`DIRECTORY_NOT_EMPTY`](https://language-research-technology.github.io/ocfl-js/guides/errors/#directory_not_empty). In your own code, create a storage root once and open it with [`openStorageRoot`](https://language-research-technology.github.io/ocfl-js/api/functions/openstorageroot/) from then on.

The [documentation site](https://language-research-technology.github.io/ocfl-js/) has guides to getting started, updating objects, concurrent writers and errors, and the full API reference. To see whether the library fits what you're building, read [Use cases and best practices](https://language-research-technology.github.io/ocfl-js/guides/use-cases/).

## What it doesn't do

- **It doesn't validate.** It reads and writes OCFL objects and storage roots, but doesn't tell you whether they conform to the OCFL specification. To check objects that another tool wrote, use an OCFL validator. See [It doesn't validate](https://language-research-technology.github.io/ocfl-js/#it-doesnt-validate) for what the library does check, and why.
- **Local file systems only.** There's no S3 or other object storage, and no way to plug in another storage backend or storage layout. A storage root must be on one file system, local or NFS, that supports hard links.
- **No paths on disk.** An opened OCFL object doesn't give out the paths of its files; you read them through the library.
- **No upgrade from OCFL 1.0.** It reads and updates OCFL 1.0 objects and storage roots, but doesn't upgrade them to OCFL 1.1.
- **No symbolic links inside a storage root.** They aren't supported.

The overview's [What it doesn't check or do](https://language-research-technology.github.io/ocfl-js/#what-it-doesnt-check-or-do) has the detail, and the rest.

## Stability

Versions follow [semantic versioning](https://semver.org/). The public API is what the [API report](docs/ocfl-fs.api.md) lists, and a change that breaks it needs a major release. Error codes are part of the API; error messages aren't, and may change in any release. A minor release can add an error code, so a `switch` on `code` needs a `default` branch; see [Errors](https://language-research-technology.github.io/ocfl-js/guides/errors/). Until 1.0 is released, a beta can change the API.

## Releases

Release notes for each stable release are on [GitHub Releases](https://github.com/Language-Research-Technology/ocfl-js/releases). Prereleases have no notes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, run the checks and send a pull request. To report a security vulnerability, see [SECURITY.md](SECURITY.md). For releases, see [RELEASING.md](RELEASING.md).

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
