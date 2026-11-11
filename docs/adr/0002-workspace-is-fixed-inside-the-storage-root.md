# The workspace is fixed inside the storage root

## Context

An update builds the new version in a workspace, then renames it into the object root, and replaces the root inventory last. That rename is what makes publishing a version atomic, and it fails if the object root already has that `vN`. A rename only works within one filesystem. The OCFL implementation notes (§3.7.1) recommend a workspace on the same filesystem as the storage root, assembled where OCFL parsers and validators ignore it.

A configurable workspace invites paths such as `/tmp` on another filesystem. Moving a version across filesystems means copying it into the object root before the final rename, so the object holds a non-OCFL directory during the copy, and keeps it after a crash. A workspace placed directly under the storage root, or equal to it, also breaks the storage root's structure rules (§4.1).

The OCFL spec lets a storage root have an `extensions` directory containing only extension sub-directories (E112), which SHOULD have a registered extension name (W016). No registered extension covers a workspace.

## Decision

- **No `workspace` option.** `OcflStorageConfig` doesn't accept a workspace path.
- **One workspace per storage root**, at `<storage root>/extensions/ocfl-js-workspace/`. Each object has one directory in it, `<workspace>/<object path>/`, where `<object path>` is the object root relative to the storage root.
- **One lock per object**, the file `<workspace>/<object path>/lock`, created exclusively and holding the time it was taken, followed by a line `no-object-root` if the object root didn't exist then. It doesn't depend on the version number. A writer takes it before anything else and holds it until its update has ended cleanly (ADR 0004).
- **The new version is built beside the lock**, at `<workspace>/<object path>/vN`, a directory the writer creates exclusively once it holds the lock. If it is already there the update is refused with `RECOVERY_NEEDED` (ADR 0004).
- **The name is a local extension.** `ocfl-js-workspace` has no `NNNN-` prefix, so it can't collide with a registered extension. `create()` documents it with a plain-text file in the storage root (§4.5).
- **No cross-filesystem moves.** If the rename into the object root fails with `EXDEV`, the update fails with an `OcflError` and nothing is copied.
- **No empty directories are left behind.** The workspace directory, and `extensions/` when nothing else uses it, are removed once empty. So are an object root and its layout parents that a failed first version created.
- **Objects stay out of `extensions/`.** An object root that would be the storage root, under `extensions/`, or outside the storage root is refused with `ID_INCOMPATIBLE_WITH_LAYOUT`, so no object can overlap a workspace. Listing a storage root's objects skips `extensions/`.
- **Every update uses this workspace.** Objects are only opened through a storage root (ADR 0003), so there is no in-place update.

## Consequences

- An update is committed when the root inventory is replaced (ADR 0004). An update that fails before that is discarded: what it built in the workspace, and what it had moved into the object root, is removed, and the object is as it was. An update that fails after it stays committed.
- An update that is interrupted, or can't be discarded, leaves its lock until the object is recovered (ADR 0004), and may leave an unfinished version in the workspace, or in the object root the directory of the next version or staged inventory files, which the root inventory doesn't name. The root inventory names only complete versions throughout.
- With a layout that nests object paths, one object's directory in the workspace can be below a version name in another's. Recovery tells them apart by the lock a live writer holds there (ADR 0004).
- A storage root with a workspace in use gets a W016 warning from validators, because `ocfl-js-workspace` isn't a registered extension name.
- Part of the object hierarchy mounted from another filesystem can't be updated. Callers get an explicit error instead of a slow copy.
- Every create or update made through this library takes the object's lock first, so a second writer of an object is refused with `UPDATE_IN_PROGRESS` before either writes content, whichever version each believes is the head.
- The lock is in the workspace, not the object root, so an object never holds a non-OCFL file, and an object that doesn't exist yet can be locked.
- Removing an empty workspace can race another update creating it, so an update retries taking the lock when the workspace vanishes between creating it and creating the lock.
