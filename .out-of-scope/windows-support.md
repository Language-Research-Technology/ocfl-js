# Windows support

The library runs on Linux and macOS. It isn't built or tested for Windows, and Windows bugs aren't fixed.

## Why this is out of scope

- CI runs on Linux only, so there's no way to find or prevent Windows bugs.
- The code assumes POSIX paths in many places. For example, the check for an object nested in another object walks up the directory tree until it reaches `/`. That never happens on a Windows drive or network share, so `update()` and `remove()` never finish (#127).
- WSL runs Linux, so Windows users can run the library there.

The README says Windows isn't supported.

Reopen this if users need native Windows. Supporting it would start with a Windows CI job, and then fixing whatever that job finds.

## Prior requests

- #127: "update() never finishes at a Windows drive root"
