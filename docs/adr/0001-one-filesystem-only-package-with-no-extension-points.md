# One filesystem-only package with no extension points

## Context

This library is meant to be the one place OCFL for JavaScript lives. Someone who needs another storage layout or digest algorithm should find it here, rather than having to discover and trust a separately published plugin.

Everything public becomes a commitment at 1.0. A registry, a hook, a backend interface or a class to subclass would have to stay compatible for plugins that may not exist, and would keep the set of supported layouts and algorithms out of sight of anyone reading this code.

## Decision

- **One package.** `@ocfl/ocfl-fs` is the only package, and it stores OCFL on a locally attached filesystem through `node:fs`.
- **No public backend API.** There's no store interface to implement and no filesystem to inject.
- **No extension or digest registration.** There are no registries, `register()` or `setup()` hooks, or hasher factories, and loading the library has no registration side effects.
- **Built-in layouts and digests only.** Both are fixed tables in the code. The layouts are official community extensions plus the library's own `000N-path-direct-storage-layout`, each chosen by name or `{ extensionName, ...params }`. A storage root declaring a layout the library doesn't implement is rejected with `UNSUPPORTED_LAYOUT`, even when a layout is configured.
- **Additions by pull request.** A new layout or digest algorithm is contributed to this repository.
- **Public classes are exported as types only.** `OcflObject`, `OcflStorage`, `OcflObjectTransaction`, `OcflObjectInventory` and `OcflObjectFile` can be named but not constructed or subclassed. Instances come from `storage()`, `createStorage()`, `loadStorage()`, `object()` and the methods on what they return. Error classes stay values, so callers can use `instanceof`.

## Consequences

- A layout or algorithm isn't usable until it has been merged and released here. A storage root using an unimplemented layout can't be opened until someone contributes that layout.
- Storing OCFL anywhere other than a filesystem isn't supported, and tests use real temporary directories.
- A change that adds a registry, an injectable backend, a public base class or a value export of one of the public classes contradicts this decision, and needs a new ADR first.
