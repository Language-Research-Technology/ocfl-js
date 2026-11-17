# Only valid storage roots and objects are read

## Context

Storage roots written by other tools, or damaged by hand, are sometimes not quite valid: no `ocfl_layout.json`, a storage layout this library doesn't implement, or an inventory that doesn't match its sidecar. A reader could work around each fault. 0.4 opened an object at any path it was given, and arocapi builds on that: the person deploying it can supply their own mapping from id to object root for a storage root whose layout it can't read.

Every workaround becomes behaviour that callers rely on and that the library must keep, like a browser's quirks mode. It also hides the fault from the owner of the storage root, who is the only one who can fix it.

## Decision

- **The library reads only valid storage roots and objects, and has no lenient mode.** A storage root must declare, in `ocfl_layout.json`, a storage layout the library implements. An OCFL object must pass the checks made when it is opened: its declaration, its root inventory and its sidecar.
- **A fault is refused with an error, never worked around.** Its owner fixes it. The error says what is wrong and, where there is a fix to make, what to make.
- **One allowance, for the library's own writes.** Between a writer's commit point and the replacement of the sidecar, the root inventory is right and its sidecar is not. This is accepted only while that object's lock is held.

## Consequences

- A storage root with no `ocfl_layout.json`, which OCFL allows, can't be opened until one is added. One that declares an official storage layout the library lacks can't be opened until the layout is added to the library (ADR 0001).
- There is no way to open an object by a path the caller works out, and no hook for a mapping from id to object root. arocapi's `objectRoot` option has no equivalent.
- Listing reports a damaged object root and carries on (`ListedDamagedObjectRoot`): it names the fault without working around it.
- "Valid" means the checks made on opening. Whether every stored file still matches its digest is a fixity check, made only when asked.
- Accepting a fault, or adding a mode that accepts faults, contradicts this decision and needs a new ADR first.
