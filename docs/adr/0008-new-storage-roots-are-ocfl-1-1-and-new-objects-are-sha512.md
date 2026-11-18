# New storage roots are OCFL 1.1, and new objects are sha512 with a `content` directory

## Context

The OCFL spec lets an OCFL object choose its digest algorithm, sha512 or sha256, and the name of its content directory. It recommends sha512, and the content directory is `content` unless the inventory names another. A storage root and each OCFL object in it declare their own OCFL version, and an object can't be of a later version than its storage root (E081).

Every option is a public commitment (ADR 0002). An option to write sha256 or another content directory would have to be kept, tested and documented, for no need any consumer has shown.

Upgrading to a later OCFL version is a migration across a whole storage root.

## Decision

- **A new storage root is OCFL 1.1.** `createStorageRoot()` has no option for the OCFL version.
- **A new OCFL object takes its storage root's OCFL version.** In a 1.0 storage root, `root.create` makes a 1.0 object.
- **A new OCFL object uses the spec's defaults: sha512 and a `content` directory.** `root.create` has no option for either: the inventory names `sha512` as the digest algorithm and `content` as the content directory.
- **An existing OCFL object keeps its OCFL version and digest algorithm.** An opened object reports the OCFL version its declaration gives and the digest algorithm its inventory names. A 1.0 object in a 1.1 storage root opens, reports 1.0, and stays 1.0 when updated. Objects that use sha256 or another content directory are read and updated as they are.
- **An OCFL object can't be of a later OCFL version than its storage root.** Opening or updating a 1.1 object in a 1.0 storage root throws `INVALID_OBJECT` (E081). Listing yields its object root as damaged, with that error, and carries on.
- **There is no upgrade.** The library doesn't upgrade an OCFL object or a storage root from 1.0 to 1.1. Upgrading is a job for other tooling ([out of scope](../../.out-of-scope/ocfl-version-upgrade.md)).
- **A new OCFL version is read before it is written.** The library learns to read a new OCFL version, by adding it to `OcflSpecVersion` and `OCFL_CONSTANTS.OCFL_VERSIONS`, in a minor release. `createStorageRoot()` makes storage roots of the new version only from a major release.

## Consequences

- A caller who needs sha256 objects, or OCFL 1.0 storage roots, makes them with another tool. This library then reads and updates them.
- Every release of one major version makes storage roots of the same OCFL version. An earlier release, or another tool that knows only that version, never meets a storage root of a version it can't read.
- A storage root stays at the OCFL version it was made with for as long as this library is the only tool writing it.
- Adding an option for the digest algorithm, the content directory or the OCFL version, or an upgrade, contradicts this decision and needs a new ADR first.
