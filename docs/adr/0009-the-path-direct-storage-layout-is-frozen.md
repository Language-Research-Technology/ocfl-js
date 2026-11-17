# The path-direct storage layout is frozen

## Context

`000N-path-direct-storage-layout` is the library's own storage layout. It maps an object id to an object root spelled by the id, so a storage root can be browsed by id. Every LDaCA consumer configures it, and production storage roots declare it in `ocfl_layout.json`.

Its name imitates a registered OCFL extension: `000N` stands where a registered extension has its number. It isn't registered, so OCFL validators warn about it.

The object root it gives each id is state on disk for every OCFL object in those storage roots. The library finds an object only by mapping its id again, so a mapping that gave an existing id a different object root would lose that object.

The mapping applies the `replace` pairs with `String.prototype.replace`, then parses the id with Node's WHATWG URL parser (`URL.parse()`). The parser lower-cases the scheme and a special scheme's host, percent-encodes characters such as spaces, and gives the host without its port or credentials. The library doesn't control how Node's parser behaves.

## Decision

- **The name is frozen.** It stays `000N-path-direct-storage-layout`, although it looks registered, because production storage roots declare it. Whether to register the layout upstream is a separate question (#190).
- **The mapping is frozen.** For every id and every value of `omitScheme`, `replace` and `suffix`, the object root is the one this release gives, as its generated extension documentation describes.
- **The layout tests guard the URL parser.** They pin exact object roots for ids the parser normalises: scheme and host case, ports, credentials, percent-encoding in the path, query and fragment, non-ASCII and IDNA hosts, numeric IPv4 hosts, backslashes, whitespace, non-special schemes, and `$` in a replacement. They pin that ids with `.` or `..` segments are refused. CI runs them on each Node major version the library supports.
- **No storage layout nests object roots.** Path-direct ends every object root with `suffix`, and refuses an id whose object root would have `suffix` part-way through, or a `.` or `..` segment. `0002-flat-direct-storage-layout` maps every id to one segment, and the hashed storage layouts map every id to the same depth.
- **Ids that map to one object root are accepted.** Ids the URL parser normalises to the same URL map to the same object root: ids that differ only in the case of the scheme or a special scheme's host, a port, credentials, percent-encoding (`…/a b` and `…/a%20b`), a backslash for a slash, surrounding whitespace, or a Unicode host and its punycode form. The layout doesn't refuse them, because that would refuse ids, such as ones with spaces, that consumers already store.

## Consequences

- Validators warn about the name for as long as it isn't registered.
- Two ids that map to one object root can't both be stored, and the first is never touched by the second. Once one is created, the other's object root holds an OCFL object with another id: `open` and `purge` refuse it with `OBJECT_ROOT_CONFLICT`, `has` gives `true` because it doesn't read the inventory, and `create` refuses it with `OBJECT_EXISTS`.
- A Node release whose URL parser maps a pinned id differently fails the layout tests once CI runs it. Nothing checks the mapping at run time, so a Node version CI hasn't run, such as the lowest the library supports or one newer than CI's, is trusted to map as before.
- Because no object root is inside another, an object's workspace directory is never inside another's (ADR 0003).
- Changing the name or the mapping contradicts this decision and needs a new ADR first.
