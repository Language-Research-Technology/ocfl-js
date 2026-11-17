# Symbolic links in a storage root

Symbolic links inside a storage root aren't supported. The library checks that object roots, workspace paths and content paths stay inside the storage root or object root, but it checks the path text only. It doesn't call `realpath` and never looks for links, so what happens when one is there isn't defined and may change.

## Known effects

None of these is a promise.

- Opening, checking for, creating, updating or purging an OCFL object by its id follows a link on the way to its object root, or at it, so it reads, writes and deletes wherever the link points, even outside the storage root. Purging an object whose object root is a link deletes the content at the target, then removes the link.
- Listing skips that link, so an OCFL object reached through it opens by its id but isn't listed. `unfinishedWrites()` skips a linked directory or lock in the workspace the same way, though opening and recovering the object by its id follow it.
- Reading a stored file, or a fixity check, follows a link at the stored file or at any directory on the way to it inside the object root, and uses the target's content, even when the target is outside the storage root.

## Why this is out of scope

- To plant a link, an attacker already needs write access inside the storage root. With that access they can change or delete objects directly, so following a link gives them little more.
- OCFL forbids links in objects (E090). A storage root that contains one is already invalid.
- Resolving every path with `realpath` adds a filesystem call to each read and write, and the file-store layer has no `realpath` today.

The overview page on the documentation site and `SECURITY.md` say links aren't supported, and tell users to give write access to a storage root only to processes they trust.

Reopen this if the library starts to read storage roots that untrusted parties can write to.

## Prior requests

- #106: "Symlinks in a storage root"
