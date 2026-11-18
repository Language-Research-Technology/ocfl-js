# A command-line tool

The library ships no command-line tool. There is no `bin` in this package and no separate CLI package. Listing objects, running a fixity check and recovering unfinished writes are done from a short script.

## Why this is out of scope

- A CLI's commands, flags, output and exit codes would be a second public contract beside the API report (ADR 0002), kept compatible across releases.
- A separate package contradicts [ADR 0001](../docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md), which makes `@ocfl/ocfl-fs` the only package.
- Recovering an unfinished write needs the caller's word that no writer is alive. A `recover` command would need its own way to take that word for each unfinished write, or it would recover writes that are still running.
- Each operation is already one call, so a script is short:

```ts
for await (const write of root.unfinishedWrites()) {
  if (write.lockedAt < restartedAt) await write.recover();
}
```

The [looking-after-a-storage-root guide](https://language-research-technology.github.io/ocfl-js/guides/looking-after-a-storage-root/) has a scheduled fixity check, and the [concurrent-writers guide](https://language-research-technology.github.io/ocfl-js/guides/concurrent-writers/) shows recovery after a crash. Start from those.

Reopen this if operators of a storage root ask for a CLI. Supporting it would start with an ADR on where it lives and how `recover` asks which unfinished writes have a dead writer.

## Prior requests

- #409: "Decide whether to ship a command-line tool"
