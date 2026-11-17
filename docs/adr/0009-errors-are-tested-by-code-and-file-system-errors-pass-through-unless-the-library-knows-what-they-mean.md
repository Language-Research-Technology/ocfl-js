# Errors are tested by code, and file system errors pass through unless the library knows what they mean

## Context

Callers' `catch` blocks are part of the API as much as the methods are. They decide what to retry, what to report to a person, and what to recover. To do that they need a fixed way to tell one failure from another, and to know which errors the library made and which it only let through.

The library works on a local file system, often an NFS mount. Most file system errors, such as `ENOSPC` or `EACCES`, mean the same to the caller wherever they happen, and the caller already knows how to handle them. A few mean something specific at the point where they happen: `EXDEV` moving a new version into an object means the workspace is on another file system, and `EPERM` linking a lock means the file system can't hold one or refused this one. And a failure part-way through a write can leave the object in a state that only recovery fixes, whatever the file system said.

## Decision

- **One class, tested by `code`.** A failure the library detects is an `OcflError` (ADR 0002: no subclasses, made only by the library). Callers branch on `code`. The message names the object or path involved and helps in logs, but isn't part of the contract and may change in a patch release.
- **Some errors aren't an `OcflError`.** A wrong call throws `TypeError` for a missing or wrongly typed argument, an unknown option, or a storage layout or parameter `createStorageRoot` refuses; `RangeError` for a byte range `OcflFile.stream()` can't serve; and a plain `Error` for a draft used after its update finished, or an update that ends with draft operations still running. An aborted `signal` rejects with the signal's `reason`, whatever it is. Callers must not test any of these for a `code`.
- **A file system error takes one of three paths:**
  1. Where the library expects it and knows what it means, it becomes the `OcflError` for that meaning, such as `CROSS_FILESYSTEM_MOVE`, `UNSUPPORTED_FILESYSTEM` or `INVALID_OBJECT` for a stored file that is missing, with the file system error as `cause`.
  2. Where it leaves a write needing recovery, it becomes `RECOVERY_NEEDED`, with the failure as `cause` (ADR 0005 says when).
  3. Anything else passes through untouched, as the plain Node error. Today that includes every `ENOSPC` and `EACCES`.
- **A probe isn't a failure.** Where a file system call is how the library asks whether something exists, or whether an object's lock is free, its error is the answer, not a fault. An answer that makes the operation impossible is the `OcflError` for that, such as `OBJECT_NOT_FOUND`, `OBJECT_LOCKED` or `ID_INCOMPATIBLE_WITH_LAYOUT`, without the file system error as `cause`.
- **`ocflCode` points to a rule; it isn't a validation report.** When the fault breaks a rule the OCFL specification numbers, `ocflCode` names it, such as `E060`. Only `INVALID_OBJECT` and `INVALID_STORAGE_ROOT` carry one. The library isn't a validator (ADR 0007): it stops at the first fault it finds, so an error names one rule, not every rule the object breaks.
- **The list of codes grows as ADR 0002 allows.** `OcflErrorCode` is a union the library hands back, so a minor release may add a code, and callers keep a `default` branch.

## Consequences

- A caller's `catch` checks `instanceof OcflError` and switches on `code`, with a `default` branch for codes added later. Anything else is a wrong call, an abort, or a file system error the library had nothing to add to.
- A caller that handles `ENOSPC` or `EACCES` itself can rely on getting the plain Node error, except inside `RECOVERY_NEEDED`, where the caller must recover first anyway.
- Code that turns a new file system error into an `OcflError` picks the code for its meaning, or adds one, and sets `cause`.
- Renaming or removing a code, moving a failure from one code to another, or moving a file system error from one path to another changes what callers' `catch` blocks see, and is a breaking change. That includes giving a new code to an error that passed through, since a caller handling the plain error stops seeing it. Making a wrong call throw an `OcflError`, or the reverse, is breaking too.
- The full list of codes, with what causes each and whether retrying helps, is in the doc comment on `OcflErrorCode` and the website's errors guide.
