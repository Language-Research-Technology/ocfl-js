# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so more than one writer can reach an OCFL object at once: two processes on one host, or two hosts. Two writers that interleave can each publish a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

Each object has one lock, a file in the workspace (ADR 0002). A lock can outlive its writer: a process that is killed, or a host that loses power, never releases it.

Telling a dead writer from a slow one needs something the lock can't reliably give on shared storage. A process id means nothing on another host. A heartbeat or an expiry time depends on clocks that differ between hosts, and on a writer that can stall for minutes on a slow mount and then carry on. Operating-system file locks behave differently across NFS versions and servers, and can be lost silently. A wrong guess lets a second writer in while the first is still working, which is the damage the lock exists to prevent.

An opened OCFL object is the object as read at one moment. A writer can hold one that is no longer the head, because another writer has committed since.

Committing an update takes several filesystem steps: the new version directory is moved into the object root, then the root inventory is replaced, then its sidecar. Any of them can fail, and so can the clean-up after a failure. Putting the old root inventory back after a late failure lets a reader see the new head appear and then vanish, and a failure during that undo leaves the object in a state nobody chose. A caller who gets an error needs to know whether the version exists.

On NFS a rename can take effect while its reply is lost, so the call fails although the root inventory was replaced.

A create writes the object declaration before its root inventory, so for a moment, and for good if the writer dies there, the object root has a declaration and no inventory. A damaged object can look the same.

A dead writer can only have left certain things. It always leaves its lock, which it takes first and releases last. In the workspace it leaves the version it was assembling. In the object root it leaves, at most, staged root inventory files and one version directory the root inventory doesn't name: the version after the head, or for a create the first version, beside the declaration.

## Decision

- **A second writer is refused straight away.** `root.create` and `object.update` take the object's lock before anything else. If it is taken they throw `UPDATE_IN_PROGRESS` and change nothing. The library never waits or queues behind another writer.
- **Dead writers are not detected.** The library never expires a lock, and never removes one it didn't take. The lock records no process id, host or heartbeat, and no operating-system file lock is used.
- **The lock says when it was taken.** The time is written into the lock, and `UPDATE_IN_PROGRESS` carries it as `lockedAt`. Whether that is too long ago is for the caller to judge. Reading the time is best effort: a lock that exists is held even if it can't be read, and then `lockedAt` is absent.
- **An out-of-date object is refused.** With the lock held, an update compares the head of the object it was called on with the head the root inventory on disk names, before the callback runs and again when it commits, before anything in the object root changes. If they differ it throws `OBJECT_OUT_OF_DATE` and discards the update. A create that finds a root inventory throws `OBJECT_EXISTS`.
- **A version is assembled in a directory its writer made.** With the lock held, the writer creates the version's directory in the workspace exclusively. If it is already there, left by a dead writer whose lock has gone, the update releases its lock, changes nothing and throws `RECOVERY_NEEDED`, so leftover files never become part of a version.
- **A create that isn't committed is not an object yet.** While an object root has a declaration, no root inventory and a held lock, `root.open` throws `OBJECT_NOT_FOUND` and `root.create` throws `UPDATE_IN_PROGRESS`. Without the lock that state is damage: `root.open` throws `INVALID_OBJECT` and `root.create` throws `OBJECT_EXISTS`. Opening a healthy object never looks at the lock.
- **An update has one commit point: the rename that replaces the root `inventory.json`.** Before it the update isn't committed, and after it the update is, whatever happens next. Nothing puts a replaced root inventory back.
- **A failure before the commit point discards the update.** Everything it made is removed, the lock is released, and the original error is thrown as it is. A retry starts from the object as it was.
- **A failure after the commit point throws `RECOVERY_NEEDED`**, with the failure as its `cause`, and keeps the lock. That covers replacing the sidecar and removing the lock. The version stays committed and nothing is undone.
- **A failed commit-point rename is checked against the disk.** If the root inventory then names the new head, or can't be read, the update is treated as past the commit point: `RECOVERY_NEEDED`, the lock kept, nothing undone. Only a root inventory that still names the old head lets the update be discarded.
- **A failure to discard an update throws `RECOVERY_NEEDED`** too, with the update's original failure as its `cause`, and keeps the lock.
- **The lock is released only when the update ends cleanly**: once it is committed and its sidecar is in place, or once it is discarded and everything it made is gone. An empty workspace directory that can't be removed is harmless, and doesn't count as a failure.
- **`root.recover(id)` clears a lock on the caller's word that no writer is alive.** It applies the commit-point rule to what it finds, and removes only what a dead writer can have left:
  - the unfinished version in the workspace, unless a lock is held below it: with a layout that nests object paths, another object's directory in the workspace can be there;
  - with a root inventory, the staged inventory files and the directory of the version after the head. A root inventory whose sidecar is stale or missing is a committed update, and is completed by writing the sidecar;
  - with no root inventory, a declaration and a lock, the create wasn't committed: the declaration, the first version and the staged inventory files are removed.

  Anything else is left alone. A declaration with no root inventory and either no lock or a version other than the first is damage, not a dead create: recovery throws `INVALID_OBJECT` and changes nothing. So does an object root inside another object, with `ID_INCOMPATIBLE_WITH_LAYOUT` if it holds no object. The lock is released last. Recovery never makes a version the head, and with nothing to clear it does nothing.
- **A lock records whether the object root existed when it was taken.** That is how recovery tells an object root a dead create made, which it removes along with the layout directories left empty above it, from one that was already there, which it keeps.

## Consequences

- Retrying is the caller's choice. After `UPDATE_IN_PROGRESS` it can wait and try again; after `OBJECT_OUT_OF_DATE` it opens the object again and repeats the update.
- A slow writer is never trampled, however long it takes.
- A writer that dies leaves its lock, and the object can't be updated until someone who knows the writer is dead clears it with `root.recover(id)`. The library can't make that call; `lockedAt` is what it offers towards it.
- Recovering an object whose writer is still alive destroys that writer's update, and lets a second writer in beside it. Nothing in the library guards against this.
- Recovery can be repeated: if it fails part-way the lock is still there, and calling it again finishes the job.
- `lockedAt` is the writer's own clock, so it is comparable across hosts only as far as their clocks agree.
- Only writers that use this library's lock are kept apart. Another tool writing to the same object is caught only if it has moved the head by the time the update checks it.
- Readers take no lock, so opening an object never waits on a writer.
- "Was the update committed?" has one answer, which the root inventory on disk gives. Any error other than `RECOVERY_NEEDED` means it wasn't, and the update can be repeated without applying a change twice.
- After `RECOVERY_NEEDED` the update may or may not be committed, and the caller must not simply repeat it. The object stays readable, and later updates of it throw `UPDATE_IN_PROGRESS` until it is recovered. The caller recovers it, opens it again, and repeats the update only if the head hasn't moved.
- Between the commit point and the sidecar's replacement, and for as long as a failure leaves it so, the root inventory doesn't match its sidecar. Opening an object allows for that: it accepts a root inventory that is identical to the head version's own inventory.
- An object that `RECOVERY_NEEDED` leaves locked holds one of a few things: a committed head whose sidecar is stale or missing, with the staged sidecar beside it; a complete object and only the lock; or an uncommitted update's files, in the workspace or in the object root, that the root inventory doesn't name.
- `RECOVERY_NEEDED` for a version left in the workspace is the one case that leaves the object unlocked. Recovering the object clears the leftover.
- Recovery can't destroy a committed version: a damaged object that has lost its root inventory keeps every version directory, and a stray version directory that isn't the next one stays where it is.
- A dead create whose lock was removed by hand isn't cleared by recovery. Its object root has to be removed by hand too.
- A lost rename reply costs a recovery, not a version: the caller gets `RECOVERY_NEEDED`, and the head on disk says the update was committed.
- The object `update` was called on is unchanged by a failed update, including one that was committed and then threw `RECOVERY_NEEDED`. Opening the object again shows what is on disk.
