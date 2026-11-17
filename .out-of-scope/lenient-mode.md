# A lenient mode for faults

The library has no mode that works around a fault in a storage root or OCFL object, such as an inventory that doesn't match its sidecar, a layout `config.json` the storage layout can't read, or an object declaration that is missing or wrong. It refuses each with an error that says what is wrong.

This is not about a storage root with no `ocfl_layout.json`: that is valid OCFL, and letting the caller name its storage layout isn't ruled out.

## Why this is out of scope

- Every workaround becomes behaviour callers rely on and the library must keep.
- It hides the fault from the owner of the storage root, who is the only one who can fix it.

Reopen this only with a new ADR replacing [ADR 0007](../docs/adr/0007-faults-are-refused-never-worked-around.md).

## Prior requests

None yet.
