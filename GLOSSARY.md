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

**Declaration**:
The file whose name declares that a directory is a storage root or an object root, and of which OCFL version: `0=ocfl_1.x` or `0=ocfl_object_1.x`. The OCFL spec calls it a conformance declaration, written in the NAMASTE format.
_Avoid_: Namaste file

**Damaged object root**:
An object root with an object declaration whose OCFL object the library can't open: its root inventory or sidecar is missing, corrupt or inconsistent, its declaration is invalid, or its OCFL version is later than the storage root's. Listing names it by its path from the storage root.
_Avoid_: Invalid object, broken object, corrupt object

**Object root conflict**:
An object root that the storage layout gives to an id but that holds the wrong thing: an OCFL object with another id, files that aren't an object, a file, a place below a file or inside another OCFL object, or a lock of a writer of another id. The id is fine; the storage root needs a person to look at it.
_Avoid_: Id collision, wrong object

**Version**:
One state of an OCFL object's files, numbered from 1: `v1`, `v2` and so on in the inventory. Each create or update through this library makes one. A committed version never changes; its version directory, such as `v1/`, holds the content first stored in it and a copy of the inventory as it left it.
_Avoid_: Revision, snapshot

**Head**:
The latest version of an OCFL object, named by its root inventory's `head`: `v2` after a create and one update. An update starts its draft from the head's files.
_Avoid_: Current version, tip

**Inventory**:
The `inventory.json` file that describes an OCFL object: its id, digest algorithm and head, a manifest giving the content paths of each digest, and for each version the digest at each logical path.
_Avoid_: Manifest (only one part of it), metadata

**Root inventory**:
The inventory in an object root, which names the object's head. Its sidecar is the file beside it that records its digest.
_Avoid_: Main inventory, top-level inventory

**Writer**:
A process creating, updating or purging an OCFL object through this library.
_Avoid_: Client, updater

**Purge**:
To delete an OCFL object and every version of it from the storage root, which can't be undone. Taking a file out of a draft only leaves it out of the new version; earlier versions keep it. The OCFL implementation notes use "purging" for taking one file out of every version, which this library doesn't do.
_Avoid_: Remove, delete (of an object)

**Draft**:
The changes being assembled during an update to an OCFL object, which become one new version or are discarded.
_Avoid_: Transaction

**Reinstate**:
To put a file, or every file below a directory, back in a draft as it was in an earlier version, at the same logical path.
_Avoid_: Restore (fine for fixing a stored file by hand, outside the library), revert, copy from a version

**Export**:
To write a version's files to an empty or missing directory outside the storage root, each under its logical path, with its modified-at time. The directory holds copies; nothing written there changes the OCFL object.
_Avoid_: Checkout, materialise, restore

**Workspace**:
The library's directory inside a storage root where a new version is assembled before it is moved into its object root.
_Avoid_: Staging area, temp directory, deposit directory

**Lock**:
The file in the workspace that marks an OCFL object as having a writer, held from the start of a create, update or purge until it ends cleanly. A second writer is refused, never made to wait, and the library never removes a lock because of its age.
_Avoid_: Mutex, lease, lock file

**Commit point**:
The rename that replaces an OCFL object's root inventory. Before it an update isn't committed and can be discarded; after it the update is committed, whatever happens next.
_Avoid_: Publish, finalise

**Recover**:
To clear what a dead writer left of an OCFL object and release its lock, on the caller's word that no writer is alive: an update that wasn't committed is discarded, one that was is completed, and a purge that had begun deleting is finished. A purge that hadn't begun deleting has its lock released, and nothing in the object root is touched.
_Avoid_: Repair (fine for fixing an object by hand, outside the library), unlock, roll back

**Durability**:
Whether a create or update through a storage root flushes what it writes to disk before it returns, set when the storage root is opened or created. `'full'`, the default, flushes every file and directory of the new version, so a version that returned survives a crash or power failure; `'none'` flushes only the lock, for bulk loading, and leaves the caller to run `sync`.
_Avoid_: Fsync mode, safe mode, sync option

**Unfinished write**:
A create, update or purge of an OCFL object whose lock is still held: its writer is still working, or died. The library can't tell which. An OCFL object is recovered only through its unfinished write.
_Avoid_: Stale lock, orphan, leftover

**Digest algorithm**:
The algorithm an OCFL object's digests use, `sha512` or `sha256`, named by its inventory's `digestAlgorithm`: every content digest in its manifest and state, and its inventory's sidecar. Every digest algorithm is a fixity algorithm, but not the reverse. A hashed storage layout's `digestAlgorithm` parameter names a fixity algorithm, not an object's digest algorithm.
_Avoid_: Content algorithm, hash algorithm

**Fixity algorithm**:
A digest algorithm OCFL allows in an inventory's `fixity` block. The library supports six: `md5`, `sha1`, `sha256`, `sha512`, `sha512/256` and `blake2b-512`. A hashed storage layout hashes object ids with one, named by its `digestAlgorithm` parameter.
_Avoid_: Layout algorithm

**Fixity check**:
Reading every stored file of an opened OCFL object again and comparing its digest with the one the inventory records. It gives a fixity report, with a problem for each stored file that has changed or is missing; a stored file is missing when there is no regular file at its path; it does not look for extra files or read the inventory's `fixity` block.
_Avoid_: Validation, verify, audit

**Fixity report**:
What a fixity check gives: a problem for each stored file that has changed or is missing, and how many stored files it read.
_Avoid_: Result, problems list

**Logical path**:
The path of a file in a version, the one you write and read, such as `notes/field-notes.txt`. It need not look like the content path of the stored file it reads.
_Avoid_: Filename, key, virtual path

**Content path**:
The path of a stored file from its object root, as the manifest lists it, such as `v1/content/notes/field-notes.txt`. It starts with the version directory its content was first stored in.
_Avoid_: Physical path, storage path

**Stored file**:
A file in an object root that holds the content of one digest. The manifest lists it by its content path, and a logical path reads the first stored file the manifest lists for its digest. A fixity check names it by its path from the storage root.
_Avoid_: Content file, physical file

**Created in**:
The version in which a file's logical path was created: the first of the versions up to the file's own that all have the logical path, with any content. A logical path removed and later added again is created again, and a rename creates the new logical path. Its time is the file's created-at time, from the inventory.
_Avoid_: Birth time, added in

**Modified in**:
The version in which a file's logical path took its current content: the first of the versions up to the file's own that all have the logical path with the same digest. Content changed and later changed back is modified again, rather than taking the earlier version's time. Its time is the file's modified-at time, from the inventory and never from the stored file.
_Avoid_: Last modified (of a stored file), mtime, changed in
