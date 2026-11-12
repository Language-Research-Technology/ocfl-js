# The workspace is fixed inside the storage root

## Context

An update assembles the new version in a workspace, renames it into the object root, and replaces the root inventory last. The rename puts the whole version in place at once, and a rename only works within one filesystem. The OCFL implementation notes (§3.7.1) recommend a workspace on the same filesystem as the storage root, where OCFL parsers and validators ignore it.

A configurable workspace invites paths such as `/tmp` on another filesystem. Moving a version across filesystems means copying it into the object root, so the object holds a half-copied directory during the copy, and keeps it after a crash. A workspace placed directly under the storage root, or equal to it, breaks the storage root's structure rules (§4.1).

The OCFL spec lets a storage root have an `extensions` directory holding only extension sub-directories (E112), each of which should have a registered extension name (W016). No registered extension covers a workspace.

## Decision

- **No `workspace` option.** Neither `createStorageRoot()` nor `openStorageRoot()` accepts a workspace path.
- **One workspace per storage root**, at `<storage root>/extensions/ocfl-js-workspace/`.
- **One workspace directory per object**, at `<workspace>/<object path>/`, where `<object path>` is the object root relative to the storage root. It holds the object's lock, the file `lock` (ADR 0004), and beside it the version being assembled, the directory `vN`.
- **The name is a local extension.** `ocfl-js-workspace` has no `NNNN-` prefix, so it can't collide with a registered extension. `createStorageRoot()` documents it in a plain-text file in the storage root (§4.5).
- **No cross-filesystem moves.** If the rename into the object root fails with `EXDEV`, the update fails with `CROSS_FILESYSTEM_MOVE` and nothing is copied.
- **No empty directories are left behind.** An object's workspace directory, the workspace, and `extensions/` when nothing else uses it, are removed once empty.
- **Objects stay out of `extensions/`.** An id whose object root would be the storage root, under `extensions/`, or outside the storage root is refused with `ID_INCOMPATIBLE_WITH_LAYOUT`. Listing a storage root's objects skips `extensions/`.

## Consequences

- The lock is in the workspace, not the object root, so an object never holds a non-OCFL file, and an object that doesn't exist yet can be locked.
- No storage layout nests object roots (ADR 0004), so one object's workspace directory is never inside another's.
- A storage root with a workspace in use gets a W016 warning from validators, because `ocfl-js-workspace` isn't a registered extension name.
- Part of the object hierarchy mounted from another filesystem can't be updated. Callers get an error, not a slow copy.
- Removing the empty workspace can race another writer creating it, so a writer tries again when its directory vanishes before its lock is in place.
- What an interrupted update leaves in the workspace stays there until its unfinished write is recovered (ADR 0004).
