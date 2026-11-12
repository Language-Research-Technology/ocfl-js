# One filesystem-only package with no extension points

## Context

This library is meant to be the one place OCFL for JavaScript lives. Someone who needs another storage layout, or another algorithm for content, fixity or a layout's hashing of ids, should find it here, not in a separately published plugin they have to discover and trust.

Everything public is a commitment. A registry, a hook, a backend interface or a class to subclass would have to stay compatible for plugins that may not exist, and would hide the set of supported layouts and algorithms from anyone reading the code.

## Decision

- **One package.** `@ocfl/ocfl-fs` is the only package. It stores OCFL on a locally attached filesystem through `node:fs`.
- **No extension points.** There is no backend interface to implement, no filesystem to inject, and no registry or hook for storage layouts or algorithms. Loading the library registers nothing.
- **Storage layouts and algorithms are fixed tables in the code.** The layouts are official community extensions plus the library's own `000N-path-direct-storage-layout`. One is chosen with `{ extensionName, ...params }` when a storage root is created. A storage root is opened with the layout it declares, and one that declares a layout the library doesn't implement is refused with `UNSUPPORTED_LAYOUT`.
- **Additions come by pull request** to this repository.

## Consequences

- A layout or algorithm can't be used until it is merged and released here. A storage root that uses an unimplemented layout can't be opened.
- Storing OCFL anywhere but a filesystem isn't supported.
- Adding a registry, an injectable backend, or a public base class contradicts this decision and needs a new ADR first.
