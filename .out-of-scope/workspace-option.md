# Choosing where the workspace is

Neither `createStorageRoot` nor `openStorageRoot` takes a workspace path. The workspace is always `extensions/ocfl-js-workspace/` inside the storage root.

## Why this is out of scope

A new version is moved into its object root with a rename, which works only within one filesystem, and only some places inside the storage root keep it valid. A workspace elsewhere would mean copying, and a crash part-way would leave a half-copied directory in the object.

Reopen this only with a new ADR replacing [ADR 0003](../docs/adr/0003-workspace-is-fixed-inside-the-storage-root.md).

## Prior requests

None yet.
