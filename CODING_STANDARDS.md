# Coding standards

Conventions a reviewer checks. Anything the checks in [CONTRIBUTING.md](CONTRIBUTING.md#checks) enforce isn't repeated here.

## Types

- Prefer `interface … extends` to intersecting a type with an object literal (`type A = B & { … }`), unless an interface can't extend the base (a union, mapped, conditional or primitive type, or a type parameter). `extends` flags a clashing member at the declaration (an intersection silently makes it `never`) and keeps the name in hovers, errors and the API report.
- A type in the public API that would be large gets a name, not an inline type, so the API report and hovers stay readable.

## Class members

- A member only its own class uses is `#private`, not `_`-prefixed. The runtime enforces it, and it stays out of the published types. `#private` members aren't inherited and tests can't reach them, so tests exercise them through the public API, and a member another class or a subclass needs can't be `#private`.
- A member other modules use to drive or adjust a class's internals, rather than what the class is for, has a `_` prefix and an `@internal` tag: for example `OcflObjectInventory._madeFrom`, the `_plan…` and `_apply…` methods, and static factories only the library calls (`OcflError._create`, `OcflObjectInventory._newVersion`). `stripInternal` keeps it out of the published types, and the prefix tells a reader it isn't the class's own use.
- A member that is what the class is for stays plain, even when other classes use it: for example `OcflObjectInventory.head` and `getDigest`.
