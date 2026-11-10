# Resolving symbolic links in a storage root

The library checks that object roots, workspace paths and content paths stay inside the storage root or object root, but it checks the path text only. It does not call `realpath`, so a symbolic link inside a storage root or object is followed.

## Why this is out of scope

- To plant a link, an attacker already needs write access inside the storage root. With that access they can change or delete objects directly, so following a link gives them little more.
- OCFL forbids links in objects (E090). A storage root that contains one is already invalid.
- Resolving every path with `realpath` adds a filesystem call to each read and write, and the file-store layer has no `realpath` today.

The README tells users to keep write access to the storage root limited to trusted processes.

Reopen this if the library starts to read storage roots that untrusted parties can write to.

## Prior requests

- #106: "Symlinks in a storage root"
