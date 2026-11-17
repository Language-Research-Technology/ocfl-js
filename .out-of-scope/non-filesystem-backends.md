# Storing OCFL anywhere but a filesystem

The library stores OCFL only on a locally attached filesystem through `node:fs`. There is no backend for S3 or other object stores, and no backend interface to write one.

## Why this is out of scope

- The commit and the lock need an atomic rename and hard links, which object stores don't offer.
- A backend interface would be a public extension point that has to stay compatible.

Reopen this if users need OCFL on object storage and a design for the commit and lock on it exists. Supporting it would start with a new ADR replacing [ADR 0001](../docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md).

## Prior requests

None yet.
