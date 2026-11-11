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

**Workspace**:
The library's directory inside a storage root where a new version is assembled before it is published to its OCFL object.
_Avoid_: Staging area, temp directory, deposit directory
