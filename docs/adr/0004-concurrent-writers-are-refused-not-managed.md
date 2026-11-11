# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so more than one writer can reach an OCFL object at once: two processes on one host, or two hosts. Two writers that interleave can each publish a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

Each object has one lock, a file in the workspace (ADR 0002). A lock can outlive its writer: a process that is killed, or a host that loses power, never releases it.

Telling a dead writer from a slow one needs something the lock can't reliably give on shared storage. A process id means nothing on another host. A heartbeat or an expiry time depends on clocks that differ between hosts, and on a writer that can stall for minutes on a slow mount and then carry on. Operating-system file locks behave differently across NFS versions and servers, and can be lost silently. A wrong guess lets a second writer in while the first is still working, which is the damage the lock exists to prevent.

An opened OCFL object is the object as read at one moment. A writer can hold one that is no longer the head, because another writer has committed since.

## Decision

- **A second writer is refused straight away.** `root.create` and `object.update` take the object's lock before anything else. If it is taken they throw `UPDATE_IN_PROGRESS` and change nothing. The library never waits or queues behind another writer.
- **Dead writers are not detected.** The library never expires a lock, and never removes one it didn't take. The lock records no process id, host or heartbeat, and no operating-system file lock is used.
- **The lock says when it was taken.** The time is written into the lock, and `UPDATE_IN_PROGRESS` carries it as `lockedAt`. Whether that is too long ago is for the caller to judge.
- **An out-of-date object is refused.** With the lock held, an update compares the head of the object it was called on with the head the root inventory on disk names, before the callback runs and again when it commits, before anything in the object root changes. If they differ it throws `OBJECT_OUT_OF_DATE` and discards the update. A create that finds a root inventory throws `OBJECT_EXISTS`.
- **The lock is released when the update ends cleanly**: once it is committed, or once it is discarded and everything it wrote is gone.

## Consequences

- Retrying is the caller's choice. After `UPDATE_IN_PROGRESS` it can wait and try again; after `OBJECT_OUT_OF_DATE` it opens the object again and repeats the update.
- A slow writer is never trampled, however long it takes.
- A writer that dies leaves its lock, and the object can't be updated until someone who knows the writer is dead clears it. The library can't make that call; `lockedAt` is what it offers towards it.
- `lockedAt` is the writer's own clock, so it is comparable across hosts only as far as their clocks agree.
- Only writers that use this library's lock are kept apart. Another tool writing to the same object is caught only if it has moved the head by the time the update checks it.
- Readers take no lock, so opening an object never waits on a writer.
