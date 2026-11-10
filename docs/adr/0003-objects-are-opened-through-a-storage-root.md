# Objects are opened through a storage root

## Context

The OCFL spec defines an object by its own declaration file, with no reference to a storage root, so an object can be read or validated by its path alone. Several rules can only be checked from the storage root, though: an object's version must not be later than its root's (E081), object roots must sit where the hierarchy allows (E082), ids must map to unique paths (E083), and ids must be unique within the root (E037). The spec gives an object no way to find its storage root.

An update needs a workspace on the storage root's filesystem, and a lock that every writer to the object uses. An object opened by path has neither, so it either writes its new version straight into the object root or has to search the directory tree for a storage root to borrow one from. It also has to guess its OCFL version when it is new.

ocfl-java and rocfl open objects only through a repository, and accept a bare object path only to validate it. ocfl-py and ocfl-go write objects by path, with no workspace and no locking. No known consumer of this library creates or updates an object outside a storage root, and the one that reads one by path has the storage root at hand.

## Decision

- **No top-level `object()`.** The package exports no function that opens an OCFL object by its path.
- **Objects come from a storage root.** `storage.object(id)` opens an object by its id, and `storage.object({ root })` by its object root relative to the storage root.
- **Objects take their storage root's settings.** An object's OCFL version, workspace and digest settings come from the storage root that opened it.

## Consequences

- Every update goes through a storage root, so it uses that root's workspace and its OCFL version limit, and there is no in-place update mode.
- Removing `object()` is a breaking change. A caller with an object's path opens it through its storage root, with the path relative to that root.
- A directory that isn't inside a storage root can't be opened or updated with this library.
- A read-only way to open an object by path, for example for a validator, can be added later without a breaking change.
