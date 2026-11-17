# Objects are opened through a storage root

## Context

The OCFL spec defines an OCFL object by its own declaration file, with no reference to a storage root, and gives an object no way to find its storage root. So an object can be read by its path alone.

Writing one needs more. An update needs a workspace on the storage root's filesystem (ADR 0003) and a lock that every writer of the object uses (ADR 0005). An object opened by path has neither: it must write its new version straight into the object root, or search the directory tree for a storage root. A new object would also have to guess its OCFL version (ADR 0008). And only the storage root's layout says which object root an id belongs at.

ocfl-java and rocfl also open objects only through a storage root, while ocfl-py and ocfl-go write them by path, and no known consumer of this library creates or updates an object outside a storage root (`docs/consumers.md`).

## Decision

- **Objects come from a storage root.** `root.open(id)` opens an object by its id and `root.create(id, …)` makes one. Nothing in the package opens an object by its path, read-only included.

## Consequences

- Every create, update and purge goes through a storage root, so it uses that root's workspace and lock. There is no in-place update.
- A caller that has only an object's path opens the object through its storage root, by id. Under a hashed layout it must already know the id, or read it from the object's inventory.
- A directory that isn't inside a storage root can't be opened or updated with this library.
- Opening an object by path, even read-only, needs a new ADR first.
