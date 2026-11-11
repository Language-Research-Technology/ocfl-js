# Known consumers

Who uses the library and how. Consult this before any breaking change to the public API.

Surveyed November 2026.

| Consumer                                                             | Depends on                        | What it does with the library                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language-Research-Technology/ldacapi                                 | `@ocfl/ocfl-fs` 0.4.0, direct     | Primary consumer. Imports crate directories, walks the storage root to index it, reads files by logical path at the head version. Serves files through arocapi. |
| crate-works/arocapi                                                  | 0.4.0, optional peer dependency   | Read-only. Opens objects by path, takes content paths and digests from the inventory, and serves the files itself.                                              |
| Language-Research-Technology/oni                                     | 0.2.2, direct                     | The old Oni API. Reads and indexes, builds disk paths for nginx, one endpoint updates objects with a manual transaction.                                        |
| Language-Research-Technology/oni-ocfl                                | 0.4.0, direct                     | Ingest library. `update()` with a callback, `write` and `import`.                                                                                               |
| Language-Research-Technology/corpus-tools-\* (about 15 repositories) | through oni-ocfl                  | Ingest.                                                                                                                                                         |
| Language-Research-Technology/arocapi-ldaca                           | 0.2.2, direct                     | Predecessor of ldacapi. Imports and indexes.                                                                                                                    |
| Language-Research-Technology/oni-ui                                  | 0.2.0, direct                     | Indexing scripts.                                                                                                                                               |
| Language-Research-Technology/ocfl-ro-crate-summarizer                | 0.2.0, direct                     | Walks a storage root and reads files.                                                                                                                           |
| alxp/islandty                                                        | 0.2.2, direct                     | Static site generator. Ingests files and builds public URLs from content paths. Flat-direct layout.                                                             |
| ucd-library/fin                                                      | 0.2.0, direct                     | Reads files from a Fedora 6 storage root. Hashed n-tuple layout.                                                                                                |
| onset/lameta                                                         | through oni-ocfl                  | Ingests an RO-Crate into a throwaway storage root to validate it.                                                                                               |
| redbox-mint/redbox-portal                                            | through a fork of oni-ocfl, 0.2.2 | Ingests data publications.                                                                                                                                      |

## Notes

- Every LDaCA consumer configures `000N-path-direct-storage-layout`; production storage roots declare it.
- All reads are by logical path at the head version. No consumer reads an old version, or looks a file up by digest.
- Content paths are the internal most often relied on (arocapi, oni, islandty).
- GitHub reports about 20 dependent repositories and shows 12, so some private consumers aren't listed.

## How the list was made

Code search on GitHub for both package names, npm dependents, and reading each caller.
