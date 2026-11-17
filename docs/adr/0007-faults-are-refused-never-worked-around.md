# Faults are refused, never worked around

## Context

Storage roots written by other tools, or changed by hand, sometimes have faults: an inventory that doesn't match its sidecar, a layout `config.json` the storage layout can't read, an object declaration that is missing or wrong. A reader could work around each one: skip the sidecar, guess the parameter, take a mapping from id to object root from the caller.

Every workaround becomes behaviour that callers rely on and that the library must keep, like a browser's quirks mode. It also hides the fault from the owner of the storage root, who is the only one who can fix it.

The library is not a validator. It checks what it needs to read and write a storage root safely, and refuses what fails those checks. Whether a storage root or object follows the OCFL specification in full is a question for an OCFL validator.

## Decision

- **A fault is refused with an error, never worked around.** There is no lenient mode. Its owner fixes it. The error says what is wrong and, where there is a fix to make, what to make.
- **Valid OCFL the library can't place is refused too, but is not a fault.** A storage root with no `ocfl_layout.json` is valid OCFL, but the library can't know which object root an id maps to (`LAYOUT_NOT_DECLARED`). Nor can it for a storage layout it doesn't implement (`UNSUPPORTED_LAYOUT`, ADR 0001). Letting the caller name the storage layout of a root with no `ocfl_layout.json` is not ruled out; it hasn't been needed.
- **Opening a storage root checks** that it has exactly one valid declaration (`E069`, `E076`, `E080`), an `ocfl_layout.json` with a string `extension` (`E070`), and a storage layout the library implements. Its layout `config.json`, if there is one, must be a JSON object for that storage layout, with valid values and no parameter the storage layout doesn't have (`INVALID_STORAGE_ROOT`). A parameter can change which object root an id maps to, so one the library doesn't know is never ignored.
- **Opening an OCFL object checks** that its object root holds the id asked for and isn't inside another OCFL object (`E082`); that it has one valid object declaration (`E003`, `E007`) of an OCFL version no later than the storage root's (`E081`); that a root inventory exists unless the object's lock is held (`E063`); that the root inventory is a JSON object (`E033`) naming `sha256` or `sha512` (`E025`), with a sidecar that exists and matches (`E058`, `E060`); and that the inventory is well formed: a non-empty id and head (`E036`), with the head the latest version (`E040`), versions with no gaps (`E009` to `E012`), each with a `created` time (`E049`) and a state (`E048`), version names, a `contentDirectory`, content paths and logical paths that are safe to use as paths (`E104`, `E017`, `E018`, `E099`, `E100`, `E052`, `E053`), no logical path that appears twice in a version or is the directory of another (`E095`), a manifest that lists each digest once (`E096`) and has content for every digest in a state (`E050`), and a `fixity` block, if there is one, of the right shape (`E111`, `E057`).
- **Opening checks nothing more.** It doesn't read the inventories of earlier versions, look for extra files, or read stored files. Whether every stored file still matches its digest is a fixity check, made only when asked.
- **One allowance, for the library's own writes.** Between a writer's commit point and the replacement of the sidecar, the root inventory is right and its sidecar is not. This is accepted only while that object's lock is held.
- **Objects are opened by id through a storage root**, never by path (ADR 0004).

## Consequences

- A storage root with no `ocfl_layout.json` can't be opened until one is added. One that declares an official storage layout the library lacks can't be opened until the layout is added to the library (ADR 0001).
- A storage root whose layout `config.json` has a parameter the storage layout doesn't have can't be opened until the parameter is removed. The library implements every parameter of the official storage layouts it has, and defines the parameters of its own path-direct storage layout, so such a parameter is never one it forgot.
- There is no hook for a mapping from id to object root.
- Listing reports a damaged object root and carries on (`ListedDamagedObjectRoot`): it names the fault without working around it.
- Accepting a fault, or adding a mode that accepts faults, contradicts this decision and needs a new ADR first.
