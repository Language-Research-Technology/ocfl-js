# One filesystem-only package with no extension points

## Context

This library is meant to be the one place OCFL for JavaScript lives. Someone who needs another storage layout, or another algorithm for content, fixity or a layout's hashing of ids, should find it here, not in a separately published plugin they have to discover and trust.

Everything public is a commitment. A registry, a hook, a backend interface or a class to subclass would have to stay compatible for plugins that may not exist, and would hide the set of supported layouts and algorithms from anyone reading the code.

The same goes for what the package needs to run: which Node.js versions, which module systems, and what the filesystem it is given may hold.

## Decision

- **One package.** `@ocfl/ocfl-fs` is the only package. It stores OCFL on a locally attached filesystem through `node:fs`.
- **No extension points.** There is no backend interface to implement, no filesystem to inject, and no registry or hook for storage layouts or algorithms. Loading the library registers nothing.
- **Storage layouts and algorithms are fixed tables in the code.** The layouts are official community extensions plus the library's own `000N-path-direct-storage-layout`. One is chosen with `{ extensionName, ...params }` when a storage root is created. A storage root is opened with the layout it declares, and one that declares a layout the library doesn't implement is refused with `UNSUPPORTED_LAYOUT`.
- **Additions come by pull request** to this repository.
- **No runtime dependencies.**
- **No files of its own at run time.** The package reads only the storage roots it is given. Text it writes, such as an extension's documentation, is in the code, so the package works bundled.
- **ESM only, from Node.js 22.12.** Node.js 22.12 is the first release where CommonJS code can `require()` an ES module without a flag, and oni-ocfl, which the corpus-tools repositories use, loads the library that way (`docs/consumers.md`). So no module uses top-level `await`, which `require()` can't load. Without CommonJS callers the floor would be 22.1, for `URL.parse`.
- **The Node.js versions that still get updates are supported.** A minor release may drop one that has stopped. When Node.js 22 stops getting updates, in April 2027, a minor release raises the floor to 24.
- **Symbolic links inside a storage root aren't supported.** [`.out-of-scope/symlinks-in-storage-root.md`](../../.out-of-scope/symlinks-in-storage-root.md) says what the library does with one, and why.

## Consequences

- A layout or algorithm can't be used until it is merged and released here. A storage root that uses an unimplemented layout can't be opened.
- Storing OCFL anywhere but a filesystem isn't supported. The commit and the lock need a rename that is atomic (ADR 0003) and hard links (ADR 0005), which object stores such as S3 don't offer.
- Adding a registry, an injectable backend, or a public base class contradicts this decision and needs a new ADR first.
