# Custom storage layouts and algorithms

The library has no way to plug in a storage layout, or a digest, fixity or hashing algorithm, from outside it. There is no registry, hook or base class for them.

## Why this is out of scope

- The library is meant to be the one place OCFL for JavaScript lives, so a layout or algorithm someone needs belongs in it, not in a plugin others have to find and trust.
- A registry or hook is a public extension point that has to stay compatible.

To add a layout or algorithm, send a pull request to this repository, as [`CONTRIBUTING.md`](../CONTRIBUTING.md) describes.

Reopen this only with a new ADR replacing [ADR 0001](../docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md).

## Prior requests

None yet.
