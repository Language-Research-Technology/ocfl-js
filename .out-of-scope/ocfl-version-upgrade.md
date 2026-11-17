# Upgrading OCFL versions

The library doesn't upgrade an OCFL object or a storage root from OCFL 1.0 to 1.1. It reads and updates OCFL 1.0 objects and storage roots, and keeps them at 1.0.

## Why this is out of scope

- Upgrading is a one-off job across a whole storage root: each object's declaration and inventory are written again, and the storage root's declaration changes. It is a migration, not part of storing and versioning objects, and other tooling is better placed to do it.
- The library writes only the OCFL version its storage root declares, and a new storage root is always OCFL 1.1. [ADR 0008](../docs/adr/0008-new-storage-roots-are-ocfl-1-1-and-new-objects-are-sha512.md) records these rules.
- An object can't be of a later OCFL version than its storage root (E081), so an upgrade has to change the storage root and its objects in the right order, while no writer is at work. That needs its own design for locking and for what a crash part-way leaves behind.

The overview page on the documentation site says there's no upgrade from OCFL 1.0.

Reopen this if users ask for an upgrade and no other tool does it for them. Supporting it would start with a new ADR on how an upgrade is locked and recovered.

## Prior requests

None yet.
