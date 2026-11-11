# macOS and case-insensitive filesystems

The library is supported and tested on Linux, on a case-sensitive filesystem. It isn't tested on macOS or on any case-insensitive filesystem, and bugs that only show up there aren't fixed.

## Why this is out of scope

- CI runs on Linux only, on a case-sensitive filesystem, so there's no way to find or prevent macOS bugs.
- macOS's default filesystem (APFS) is case-insensitive. Two logical paths that differ only in case, such as `README.md` and `readme.md`, are one file there, and nothing tests what the library does with them.

The README says macOS isn't supported and that the filesystem must be case-sensitive.

Reopen this if users need macOS or a case-insensitive filesystem. Supporting it would start with a macOS CI job, and then fixing whatever that job finds.

## Prior requests

- #196: "Say that only Linux on a case-sensitive file system is supported"
