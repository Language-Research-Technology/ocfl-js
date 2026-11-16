# OCFL for JavaScript

Terms used by this library for storing and versioning digital objects under the Oxford Common File Layout (OCFL).

## Language

**Storage root**:
The base directory holding OCFL objects, identified by its `0=ocfl_1.x` declaration.
_Avoid_: Repository, store

**Storage layout**:
The rule a storage root uses to map an object id to the directory of its OCFL object, named in the root's `ocfl_layout.json`, with its parameters in `extensions/<name>/config.json`.
_Avoid_: Layout extension, path mapping, storage scheme

**OCFL object**:
A directory holding one digital object's versions and its inventory. An opened OCFL object is the object as read at one moment; it does not change when later versions are committed.
_Avoid_: Record, item, snapshot

**Object root**:
The directory of an OCFL object, where the storage layout places it in the storage root.
_Avoid_: Object directory, object folder

**Damaged object root**:
An object root with an object declaration whose OCFL object the library can't open: its root inventory or sidecar is missing, corrupt or inconsistent, its declaration is invalid, or its OCFL version is later than the storage root's. Listing names it by its path from the storage root.
_Avoid_: Invalid object, broken object, corrupt object

**Object root conflict**:
An object root that the storage layout gives to an id but that holds the wrong thing: an OCFL object with another id, files that aren't an object, a file, a place below a file or inside another OCFL object, or a lock of a writer of another id. The id is fine; the storage root needs a person to look at it.
_Avoid_: Id collision, wrong object

**Root inventory**:
The inventory in an object root, which names the object's head: its latest version. Its sidecar is the file beside it that records its digest.
_Avoid_: Main inventory, top-level inventory

**Writer**:
A process creating, updating or removing an OCFL object through this library.
_Avoid_: Client, updater

**Draft**:
The changes being assembled during an update to an OCFL object, which become one new version or are discarded.
_Avoid_: Transaction

**Reinstate**:
To put a file, or every file below a directory, back in a draft as it was in an earlier version, at the same logical path.
_Avoid_: Restore, revert, copy from a version

**Workspace**:
The library's directory inside a storage root where a new version is assembled before it is moved into its object root.
_Avoid_: Staging area, temp directory, deposit directory

**Lock**:
The file in the workspace that marks an OCFL object as having a writer, held from the start of a create, update or remove until it ends cleanly. A second writer is refused, never made to wait, and the library never removes a lock because of its age.
_Avoid_: Mutex, lease, lock file

**Commit point**:
The rename that replaces an OCFL object's root inventory. Before it an update isn't committed and can be discarded; after it the update is committed, whatever happens next.
_Avoid_: Publish, finalise

**Recover**:
To clear what a dead writer left of an OCFL object and release its lock, on the caller's word that no writer is alive: an update that wasn't committed is discarded, one that was is completed, and a remove that had begun deleting is finished.
_Avoid_: Repair, unlock, roll back

**Unfinished write**:
A create, update or remove of an OCFL object whose lock is still held: its writer is still working, or died. The library can't tell which. An OCFL object is recovered only through its unfinished write.
_Avoid_: Stale lock, orphan, leftover

**Digest algorithm**:
The algorithm an OCFL object's digests use, `sha512` or `sha256`, named by its inventory's `digestAlgorithm`: every content digest in its manifest and state, and its inventory's sidecar. Every digest algorithm is a fixity algorithm, but not the reverse. A hashed storage layout's `digestAlgorithm` parameter names a fixity algorithm, not an object's digest algorithm.
_Avoid_: Content algorithm, hash algorithm

**Fixity algorithm**:
A digest algorithm OCFL allows in an inventory's `fixity` block. The library supports six: `md5`, `sha1`, `sha256`, `sha512`, `sha512/256` and `blake2b-512`. A hashed storage layout hashes object ids with one, named by its `digestAlgorithm` parameter.
_Avoid_: Layout algorithm

**Fixity check**:
Reading every stored file of an opened OCFL object again and comparing its digest with the one the inventory records. It reports each stored file that has changed or is missing; it does not look for extra files or read the inventory's `fixity` block.
_Avoid_: Validation, verify, audit

**Stored file**:
A file in an object root that holds the content of one digest. The manifest lists it by its content path, and a logical path reads the first stored file the manifest lists for its digest. A fixity check names it by its path from the storage root.
_Avoid_: Content file, physical file

**Created in**:
The version in which a file's logical path was created: the first of the versions up to the file's own that all have the logical path, with any content. A logical path removed and later added again is created again, and a rename creates the new logical path. Its time is the file's created-at time, from the inventory.
_Avoid_: Birth time, added in

**Modified in**:
The version in which a file's logical path took its current content: the first of the versions up to the file's own that all have the logical path with the same digest. Content changed and later changed back is modified again, rather than taking the earlier version's time. Its time is the file's modified-at time, from the inventory and never from the stored file.
_Avoid_: Last modified (of a stored file), mtime, changed in
