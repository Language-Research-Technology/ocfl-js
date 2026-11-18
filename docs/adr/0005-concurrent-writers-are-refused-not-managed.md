# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so two writers can reach an OCFL object at once. Writers that interleave can each commit a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

A lock keeps writers apart, but it can outlive its writer: a killed process or a host that loses power never releases it. Nothing on shared storage reliably tells a dead writer from a slow one. A process id means nothing on another host, a heartbeat or expiry depends on clocks that differ between hosts, and operating-system file locks behave differently across NFS versions and can be lost silently. A wrong guess lets a second writer in beside the first.

Hosts sharing a storage root aren't always upgraded at once, so writers on different releases can reach one object. A writer that looks for the lock somewhere else thinks a locked object is free. One that reads the lock differently can't list or recover the write, or recovers it wrongly.

Committing an update takes several filesystem steps, any of which can fail, and so can the clean-up after a failure. On NFS a rename can take effect while its reply is lost. A caller who gets an error needs to know whether the version exists, and a reader mustn't see a head appear and then vanish.

## Decision

- **A second writer is refused, and dead writers are never detected.** A create, update or purge takes the object's lock (ADR 0003) before writing anything, and throws `OBJECT_LOCKED` if it is held. The library never waits, queues or expires a lock. The lock records when it was taken, and no process id, host or heartbeat.
- **The library retries only a race that commits nothing and holds no lock.** `root.createOrUpdate` starts again from its create, up to three attempts, when another writer purges the object between its create and open (`OBJECT_NOT_FOUND`) or commits to it between its open and update (`OBJECT_OUT_OF_DATE`). No other operation retries, and nothing retries `OBJECT_LOCKED`.
- **The lock is a protocol shared by every release that writes to a storage root.** The protocol is where the lock is, which follows from the storage layout and ADR 0003, what the lock records, and the names of what recovery removes from the workspace. A minor release may add a field to the lock that earlier releases can safely ignore. It may not move the lock, change what a field means, give a field a value earlier releases don't know, or rename what recovery removes. A new operation is such a value, so `UnfinishedWrite.operation` gains values only in a major release, an exception to ADR 0002. Changing the protocol takes a major release and a new ADR, and that release's upgrade guide tells users to upgrade every writer of a storage root together.
- **An update has one commit point, and nothing is rolled back after it.** The commit point is the rename that replaces the root inventory. A failure before it discards the update and throws the original error. A failure after it, or one that may have replaced the root inventory, or one while discarding, throws `RECOVERY_NEEDED` and keeps the lock.
- **A returned version is on disk, unless the caller opts out.** By default, `durability: 'full'`, a create or update flushes every file and directory of the new version before it returns, so a version that returned survives a crash or power failure. `durability: 'none'`, which `createStorageRoot` and `openStorageRoot` both accept, flushes only the lock. It is for bulk loading, and leaves the caller to run `sync`.
- **An object is recovered only on the caller's word that its writer is dead.** Held locks are listed as unfinished writes, and each is recovered on its own. There is no recovery by id alone or of every lock at once, since writers on other hosts may still be alive. Recovery removes only what a dead writer can have left, and never makes a version the head.

## Consequences

- A slow writer is never trampled. A dead writer's object can't be written until someone who knows it is dead recovers its unfinished write. `lockedAt` is all the library offers towards that call, and it is the writer's own clock.
- Apart from `root.createOrUpdate`'s bounded retry, retrying is the caller's choice. Any error but `RECOVERY_NEEDED` means the update wasn't committed and can be repeated. After `RECOVERY_NEEDED` the caller recovers, opens the object again, and repeats the update only if the head hasn't moved. A lost rename reply costs a recovery, not a version.
- Recovering a write whose writer is alive destroys its update and lets a second writer in. Two recoveries of one write at once aren't kept apart either: a claim to recover would itself be left behind by a dead recovery, and NFS caching doesn't guarantee one host sees a file another just made. The caller recovers a write from one process at a time.
- A lock must be written whole and taken by only one writer, which needs hard links. A storage root on a filesystem without them can be read but not written.
- A writer is refused while a lock is there, even one its release can't read, but a release lists and recovers only the locks it can read.
- The NFS behaviour this design is for, a rename or hard link applied though its reply was lost, is simulated in the tests, not run against NFS.
- The lock keeps apart only writers that take it. Another tool writing the same object is caught only if it has moved the head by the time an update checks.
- With `durability: 'none'`, a crash or power failure before the caller's `sync` can lose a version that returned, or leave it part-written.
- Waiting for, queueing or expiring a lock, or detecting a dead writer, contradicts this decision and needs a new ADR first.
