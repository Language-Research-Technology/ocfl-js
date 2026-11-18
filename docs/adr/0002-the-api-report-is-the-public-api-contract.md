# The API report is the public API contract

## Context

Callers build on the published types, so they should change only on purpose, and every change to them should be visible in review.

## Decision

- **The entry point exports an explicit list.** `src/index.ts` names every export: the functions `createStorageRoot()` and `openStorageRoot()`, the class `OcflError` and its guard `isOcflError()`, and types. It has no default export and no `export *`. Everything else is reached through `createStorageRoot()` and `openStorageRoot()`.
- **The objects a storage root gives are published as interfaces.** `StorageRoot`, `OcflObject`, `Version`, `OcflFile`, `Draft` and `UnfinishedWrite` are interfaces, and the classes behind them aren't exported. Only the library implements them.
- **`OcflError` is the only published class, and only the library makes one.** It is a class so callers can use `instanceof`. It has no subclasses: callers test `code`. Its constructor is private, and the factory the library uses isn't in the published types.
- **The API report is the contract.** `docs/ocfl-fs.api.md`, generated from the built types, lists the public API, and CI fails when the two differ.
- **Every export states its type**, rather than leaving it to be inferred from the code.
- **Adding to the API is a minor change, within limits set by which way a type crosses it.**
  - A type the library hands back, such as `StorageRoot`, `Layout`, `ListedObject` or `OcflErrorCode`, may gain members, and a union in it may gain values. `UnfinishedWrite.operation` is the exception: ADR 0005 keeps it for a major release.
  - What a caller passes in, such as `LayoutConfig`, `VersionDetails` or a function's options, may gain optional members, and a union in it may gain values. A function may gain optional parameters.
  - A type used both ways, such as `User`, may gain only what both rules allow. `Layout` is built from `LayoutConfig`, so a member added to a layout config also appears on `Layout`.

## Consequences

- Every change to the public API shows up in its pull request as a diff to the API report. A diff that removes or changes something already in the report is a breaking change, apart from the additions this decision allows.
- Code that tells apart the members of a union the library hands back names each member it handles and keeps a fallback for the rest, such as a `default` branch in a `switch`.
- A caller's own implementation of a published interface, such as a test double, can stop compiling when a member is added.
- Exporting a class behind one of the interfaces as a value contradicts this decision and needs a new ADR first.
- Editing a function body can't silently change a published signature.
