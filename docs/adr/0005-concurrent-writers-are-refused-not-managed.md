# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so two writers can reach an OCFL object at once. Writers that interleave can each commit a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

A lock keeps writers apart, but it can outlive its writer: a killed process or a host that loses power never releases it. Nothing on shared storage reliably tells a dead writer from a slow one. A process id means nothing on another host, a heartbeat or expiry depends on clocks that differ between hosts, and operating-system file locks behave differently across NFS versions and can be lost silently. A wrong guess lets a second writer in beside the first.

Committing an update takes several filesystem steps, any of which can fail, and so can the clean-up after a failure. On NFS a rename can take effect while its reply is lost. A caller who gets an error needs to know whether the version exists, and a reader mustn't see a head appear and then vanish.

## Decision

- **A second writer is refused, and dead writers are never detected.** A create, update or remove takes the object's lock (ADR 0003) before writing anything, and throws `UPDATE_IN_PROGRESS` if it is held. The library never waits, queues or expires a lock. The lock records when it was taken, and no process id, host or heartbeat.
- **An update has one commit point, and nothing is rolled back after it.** The commit point is the rename that replaces the root inventory. A failure before it discards the update and throws the original error. A failure after it, or one that may have replaced the root inventory, or one while discarding, throws `RECOVERY_NEEDED` and keeps the lock.
- **An object is recovered only on the caller's word that its writer is dead.** Held locks are listed as unfinished writes, and each is recovered on its own. There is no recovery by id alone or of every lock at once, since writers on other hosts may still be alive. Recovery removes only what a dead writer can have left, and never makes a version the head.

## Consequences

- A slow writer is never trampled. A dead writer's object can't be written until someone who knows it is dead recovers its unfinished write. `lockedAt` is all the library offers towards that call, and it is the writer's own clock.
- Retrying is the caller's choice. Any error but `RECOVERY_NEEDED` means the update wasn't committed and can be repeated. After `RECOVERY_NEEDED` the caller recovers, opens the object again, and repeats the update only if the head hasn't moved. A lost rename reply costs a recovery, not a version.
- Recovering a write whose writer is alive destroys its update and lets a second writer in. Two recoveries of one write at once aren't kept apart either: a claim to recover would itself be left behind by a dead recovery, and NFS caching doesn't guarantee one host sees a file another just made. The caller recovers a write from one process at a time.
- A lock must be written whole and taken by only one writer, which needs hard links. A storage root on a filesystem without them can be read but not written.
- The lock keeps apart only writers that take it. Another tool writing the same object is caught only if it has moved the head by the time an update checks.
- The rules a caller can see, for each call and each state recovery finds, are in the website's concurrent-writers and errors guides and the API's doc comments. How the lock is written and what recovery removes are in the doc comments of `src/lock.ts`, `src/draft.ts`, `src/remove.ts` and `src/recover.ts`.
