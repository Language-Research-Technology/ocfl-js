# Known consumers

Who uses the library and how. Consult this before any breaking change to the public API.

Surveyed November 2026.

## Consumers a breaking change must account for

Maintained, and on 0.4.0 or reaching it through oni-ocfl.

| Consumer                                                                 | Depends on                      | Last commit                        | What it does with the library                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language-Research-Technology/ldacapi                                     | `@ocfl/ocfl-fs` 0.4.0, direct   | Nov 2026                           | Primary consumer. Imports crate directories, walks the storage root to index it, reads files by logical path at the head version. Serves files through arocapi.                                                                    |
| crate-works/arocapi                                                      | 0.4.0, optional peer dependency | Nov 2026                           | Read-only. Opens objects by path, takes content paths and digests from the inventory, and serves the files itself. Its `objectRoot` option maps ids for storage roots with no `ocfl_layout.json` or a layout it doesn't implement. |
| Language-Research-Technology/oni-ocfl                                    | 0.4.0, direct                   | May 2026                           | Ingest library. `update()` with a callback, `write` and `import`.                                                                                                                                                                  |
| Language-Research-Technology/corpus-tools-\* (22 repositories, 6 public) | through oni-ocfl                | 2022 to Nov 2026; 10 of 22 in 2026 | Ingest.                                                                                                                                                                                                                            |

## Consumers that matter less

Unmaintained, still on 0.2.x (two releases back), or using the library only outside the product itself. A breaking change reaches these only if they choose to upgrade.

| Consumer                                              | Depends on                        | Last commit | What it does with the library                                                                                            | Why it matters less                                              |
| ----------------------------------------------------- | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Language-Research-Technology/oni                      | 0.2.2, direct                     | Oct 2025    | The old Oni API. Reads and indexes, builds disk paths for nginx, one endpoint updates objects with a manual transaction. | The old API, still on 0.2.x; quiet for a year.                   |
| Language-Research-Technology/arocapi-ldaca            | 0.2.2, direct                     | Oct 2025    | Predecessor of ldacapi. Imports and indexes.                                                                             | Superseded by ldacapi; quiet for a year.                         |
| Language-Research-Technology/oni-ui                   | 0.2.0, direct                     | Feb 2026    | Indexing scripts.                                                                                                        | Still on 0.2.x; scripts only.                                    |
| Language-Research-Technology/ocfl-ro-crate-summarizer | 0.2.0, direct                     | Aug 2023    | Walks a storage root and reads files.                                                                                    | Unmaintained since 2023.                                         |
| alxp/islandty                                         | 0.2.2, direct                     | Oct 2026    | Static site generator. Ingests files and builds public URLs from content paths. Flat-direct layout.                      | Active, but still on 0.2.x.                                      |
| ucd-library/fin                                       | 0.2.0, direct                     | Nov 2026    | Reads files from a Fedora 6 storage root. Hashed n-tuple layout.                                                         | Active, but still on 0.2.x; reads only.                          |
| redbox-mint/redbox-portal                             | through a fork of oni-ocfl, 0.2.2 | Nov 2026    | Ingests data publications.                                                                                               | Active, but on its own fork, still on 0.2.x.                     |
| onset/lameta                                          | through oni-ocfl                  | Nov 2026    | Validates an RO-Crate by ingesting it into a throwaway storage root, in a developer script only.                         | Not used by the app; its developers run it on macOS and Windows. |

## Notes

- Every LDaCA consumer configures `000N-path-direct-storage-layout`; production storage roots declare it.
- oni-ocfl is CommonJS and loads the library with `require('@ocfl/ocfl-fs')`, so it needs a Node.js that can `require()` an ES module (ADR 0001). ldacapi and arocapi are ES modules.
- All reads are by logical path at the head version. No consumer reads an old version, or looks a file up by digest.
- Content paths are the internal most often relied on (arocapi, oni, islandty). From 1.0 the library gives out no content paths: files are read through `file.stream()`, which arocapi can serve from. Apart from `StorageRoot.path`, which names the storage root itself, the only paths on disk it gives out name something it found broken, a damaged object root or a stored file that fails a fixity check (ADR 0006).
- From 1.0 a storage root must declare a storage layout the library implements (ADR 0007), and objects are opened only by id through it, never by path (ADR 0004). arocapi's `objectRoot` option has no equivalent: a storage root it served that way needs an `ocfl_layout.json`, or the layout added to the library.
- GitHub reports about 20 dependent repositories and shows 12, so some private consumers aren't listed.
- "Last commit" is the newest commit on the default branch at survey time. It shows the project is alive, not that its use of the library changed: fin, lameta and redbox-portal are large projects where the library is a small part. No listed repository is archived.
- oni had a push to another branch in September 2026.
- islandty and fin are the only users of the flat-direct and hashed n-tuple layouts found, so those layouts have no consumer in the first table.

## How the list was made

Code search on GitHub for both package names, npm dependents, and reading each caller. Last commit dates and the corpus-tools count come from the GitHub API, the count from each repository's `package.json`.
