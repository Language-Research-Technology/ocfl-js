# OCFL for JavaScript

Terms used by this library for storing and versioning digital objects under the Oxford Common File Layout (OCFL).

## Language

**Storage root**:
The base directory holding OCFL objects, identified by its `0=ocfl_1.x` declaration.
_Avoid_: Repository, store

**OCFL object**:
A directory holding one digital object's versions and its inventory. An opened OCFL object is the object as read at one moment; it does not change when later versions are committed.
_Avoid_: Record, item, snapshot

**Draft**:
The changes being assembled during an update to an OCFL object, which become one new version or are discarded.
_Avoid_: Transaction

**Reinstate**:
To put a file, or every file below a directory, back in a draft as it was in an earlier version, at the same logical path.
_Avoid_: Restore, revert, copy from a version

**Workspace**:
The library's directory inside a storage root where a new version is assembled before it is published to its OCFL object.
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
