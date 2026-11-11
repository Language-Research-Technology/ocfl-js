# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so more than one writer can reach an OCFL object at once: two processes on one host, or two hosts. Two writers that interleave can each publish a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

Each object has one lock, a file in the workspace (ADR 0002). A lock can outlive its writer: a process that is killed, or a host that loses power, never releases it.

Telling a dead writer from a slow one needs something the lock can't reliably give on shared storage. A process id means nothing on another host. A heartbeat or an expiry time depends on clocks that differ between hosts, and on a writer that can stall for minutes on a slow mount and then carry on. Operating-system file locks behave differently across NFS versions and servers, and can be lost silently. A wrong guess lets a second writer in while the first is still working, which is the damage the lock exists to prevent.

An opened OCFL object is the object as read at one moment. A writer can hold one that is no longer the head, because another writer has committed since.

Committing an update takes several file system steps: the new version directory is moved into the object root, then the root inventory is replaced, then its sidecar. Any of them can fail, and so can the clean-up after a failure. If a failure late in the commit were undone by putting the old root inventory back, a reader could see the new head appear and then vanish, and a failure during that undo would leave the object in a state nobody chose. A caller who gets an error needs to know whether the version exists.

## Decision

- **A second writer is refused straight away.** `root.create` and `object.update` take the object's lock before anything else. If it is taken they throw `UPDATE_IN_PROGRESS` and change nothing. The library never waits or queues behind another writer.
- **Dead writers are not detected.** The library never expires a lock, and never removes one it didn't take. The lock records no process id, host or heartbeat, and no operating-system file lock is used.
- **The lock says when it was taken.** The time is written into the lock, and `UPDATE_IN_PROGRESS` carries it as `lockedAt`. Whether that is too long ago is for the caller to judge.
- **An out-of-date object is refused.** With the lock held, an update compares the head of the object it was called on with the head the root inventory on disk names, before the callback runs and again when it commits, before anything in the object root changes. If they differ it throws `OBJECT_OUT_OF_DATE` and discards the update. A create that finds a root inventory throws `OBJECT_EXISTS`.
- **An update has one commit point: the rename that replaces the root `inventory.json`.** Before it the update isn't committed, and after it the update is, whatever happens next. Nothing puts a replaced root inventory back.
- **A failure before the commit point discards the update.** Everything it made is removed, the lock is released, and the original error is thrown as it is. A retry starts from the object as it was.
- **A failure after the commit point throws `RECOVERY_NEEDED`**, with the failure as its `cause`, and keeps the lock. That covers replacing the sidecar and removing the lock. The version stays committed and nothing is undone.
- **A failure to discard an update throws `RECOVERY_NEEDED`** too, with the update's original failure as its `cause`, and keeps the lock.
- **The lock is released only when the update ends cleanly**: once it is committed and its sidecar is in place, or once it is discarded and everything it made is gone. An empty workspace directory that can't be removed is harmless, and doesn't count as a failure.

## Consequences

- Retrying is the caller's choice. After `UPDATE_IN_PROGRESS` it can wait and try again; after `OBJECT_OUT_OF_DATE` it opens the object again and repeats the update.
- A slow writer is never trampled, however long it takes.
- A writer that dies leaves its lock, and the object can't be updated until someone who knows the writer is dead clears it. The library can't make that call; `lockedAt` is what it offers towards it.
- `lockedAt` is the writer's own clock, so it is comparable across hosts only as far as their clocks agree.
- Only writers that use this library's lock are kept apart. Another tool writing to the same object is caught only if it has moved the head by the time the update checks it.
- Readers take no lock, so opening an object never waits on a writer.
- "Was the update committed?" has one answer, which the root inventory on disk gives. Any error other than `RECOVERY_NEEDED` means it wasn't, and the update can be repeated without applying a change twice.
- After `RECOVERY_NEEDED` the update may or may not be committed, and the caller must not simply repeat it. The object stays readable, and later updates of it throw `UPDATE_IN_PROGRESS` until the lock is cleared.
- Between the commit point and the sidecar's replacement, and for as long as a failure leaves it so, the root inventory doesn't match its sidecar. Opening an object allows for that: it accepts a root inventory that is identical to the head version's own inventory.
- An object that `RECOVERY_NEEDED` leaves locked holds one of a few things: a committed head whose sidecar is stale or missing, with the staged sidecar beside it; a complete object and only the lock; or an uncommitted update's files, in the workspace or in the object root, that the root inventory doesn't name.
- The object `update` was called on is unchanged by a failed update, including one that was committed and then threw `RECOVERY_NEEDED`. Opening the object again shows what is on disk.
