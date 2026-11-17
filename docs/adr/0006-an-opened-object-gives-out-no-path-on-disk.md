# An opened object gives out no path on disk

## Context

Where an object's files sit on disk is set by the storage layout and the inventory, and the library manages both. An opened OCFL object is the object as read at one moment. A path into its object root would let a caller go around it:

- An object root changes as versions are added. A caller reading from it can find a later version, or an unfinished write, rather than the object it opened.
- A stored file never changes once committed, so reading through a content path gives the right content. But a caller can also write through it, changing content whose digest the inventory records.

Every path given out also becomes API to keep.

Some things the library finds can only be fixed by hand. A damaged object root can't be opened, so the only fix is to repair or delete its directory. A stored file that fails a fixity check can't be repaired through the library either: an update that writes the same content again finds its digest already in the object and keeps the stored file it has.

## Decision

- **An opened object gives out no path on disk.** No object, version or file exposes its object root or a content path. The type tests assert that `object.root` and `file.contentPath` don't exist.
- **`StorageRoot.path` is the caller's path, resolved to an absolute path.** It names the storage root the caller opened or created, and nothing inside it.
- **The library names a place inside the storage root only for something it found broken, as a path from the storage root.** The path uses `/` between directories on every platform and is never absolute. There are two:
  - `ListedDamagedObjectRoot.objectRoot`, for a damaged object root. It has no opened object, so there is no opened object to go around.
  - `FixityProblem.storedFile`, for a stored file that is missing or whose content has changed. It comes with `affects`, every version and logical path that reads that stored file.

## Consequences

- A caller reads content through `file.stream()`, `bytes()` or `text()`, never by building a path.
- A web server can't be handed a path to serve a file from directly. A read-only path can be added later without a breaking change, if a real need such as web-server offload appears.
- Repairing a stored file means copying a good copy to `storedFile` under the storage root, by hand.
- A path from the storage root is useful only to someone who knows where the storage root is, which every caller does: it opened it.
- Giving out any other path, or an absolute path other than `StorageRoot.path`, contradicts this decision and needs a new ADR first.
