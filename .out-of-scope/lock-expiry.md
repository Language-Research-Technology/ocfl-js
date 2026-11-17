# Lock expiry and dead-writer detection

The library never waits for, queues or expires a lock, and never decides on its own that a writer is dead. A second writer is refused with `OBJECT_LOCKED`, and a dead writer's lock stays until a caller recovers its unfinished write.

## Why this is out of scope

On storage shared between hosts, nothing reliably tells a dead writer from a slow one, and a wrong guess lets a second writer in beside the first, which can corrupt the object.

The [concurrent-writers guide](https://language-research-technology.github.io/ocfl-js/guides/concurrent-writers/) shows how to find and recover unfinished writes.

Reopen this only with a new ADR replacing [ADR 0005](../docs/adr/0005-concurrent-writers-are-refused-not-managed.md).

## Prior requests

None yet.
