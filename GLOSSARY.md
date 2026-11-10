# OCFL for JavaScript

Terms used by this library for storing and versioning digital objects under the Oxford Common File Layout (OCFL).

## Language

**Storage root**:
The base directory holding OCFL objects, identified by its `0=ocfl_1.x` declaration.
_Avoid_: Repository, store

**OCFL object**:
A directory holding one digital object's versions and its inventory.
_Avoid_: Record, item

**Workspace**:
The library's directory inside a storage root where a new version is assembled before it is published to its OCFL object.
_Avoid_: Staging area, temp directory, deposit directory
