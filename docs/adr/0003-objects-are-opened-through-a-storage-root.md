# Objects are opened through a storage root

## Context

The OCFL spec defines an OCFL object by its own declaration file, with no reference to a storage root, and gives an object no way to find its storage root. So an object can be read by its path alone.

Writing one needs more. An update needs a workspace on the storage root's filesystem (ADR 0002) and a lock that every writer of the object uses (ADR 0004). An object opened by path has neither: it must write its new version straight into the object root, or search the directory tree for a storage root. A new object would also have to guess its OCFL version. And only the storage root's layout says which object root an id belongs at.

ocfl-java and rocfl open objects only through a storage root, and accept a bare object path only to validate it. ocfl-py and ocfl-go write objects by path, with no workspace and no locking. No known consumer of this library creates or updates an object outside a storage root, and the one that reads an object by path has the storage root at hand (`docs/consumers.md`).

## Decision

- **Objects come from a storage root.** `root.open(id)` opens an object by its id and `root.create(id, …)` makes one. Nothing in the package opens an object by its path.
- **A new object takes its storage root's OCFL version.**
- **A new object is always sha512 with a `content` directory.** `root.create` has no option for either: the inventory names `sha512` as the content algorithm and `content` as the content directory.
- **An existing object keeps its own OCFL version and content algorithm.** An opened object reports the OCFL version its declaration gives and the content algorithm its inventory names. A 1.0 object in a 1.1 storage root opens, reports 1.0, and stays 1.0 when updated.

## Consequences

- Every create, update and remove goes through a storage root, so it uses that root's workspace and lock. There is no in-place update.
- A caller that has only an object's path opens the object through its storage root, by id. Under a hashed layout it must already know the id, or read it from the object's inventory.
- A directory that isn't inside a storage root can't be opened or updated with this library.
- A read-only way to open an object by path, for example for a validator, can be added without a breaking change.
