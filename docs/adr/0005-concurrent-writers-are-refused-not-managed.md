# Concurrent writers are refused, not managed

## Context

A storage root is often an NFS mount shared between hosts, so two writers can reach an OCFL object at once. Writers that interleave can each commit a version built on files the other never saw, or leave a root inventory that doesn't match the versions on disk.

A lock keeps writers apart, but it can outlive its writer: a killed process or a host that loses power never releases it. Nothing on shared storage reliably tells a dead writer from a slow one. A process id means nothing on another host. A heartbeat or expiry time depends on clocks that differ between hosts, and a writer can stall for minutes on a slow mount and then carry on. Operating-system file locks behave differently across NFS versions and can be lost silently. A wrong guess lets a second writer in beside the first, which is the damage the lock exists to prevent.

An opened OCFL object is the object as read at one moment, so a writer can hold one that another writer has since moved on from.

Committing an update takes several filesystem steps: the version directory is moved into the object root, then the root inventory is replaced, then its sidecar. Any step can fail, and so can the clean-up after a failure. Putting the old root inventory back after a late failure would let a reader see a head appear and then vanish. On NFS a rename can take effect while its reply is lost, so the call fails although the root inventory was replaced. A caller who gets an error needs to know whether the version exists.

After a host crashes, its caller may not know which objects it was writing. With a hashed storage layout an id can't be worked out from a directory, and a create whose writer dies before its commit point leaves no inventory naming the id.

Two writers whose object roots nest would hold different locks, so neither lock would keep them apart. Of the built-in layouts only path-direct could place one object root inside another. A storage root another tool wrote can still hold one.

## Decision

### Locking

- **A second writer is refused straight away.** `root.create`, `object.update` and `root.remove` take the object's lock (ADR 0003) before they write anything. If it is held they throw `UPDATE_IN_PROGRESS` and change nothing. The library never waits or queues.
- **Dead writers are not detected.** The library never expires a lock. The lock records no process id, host or heartbeat, and no operating-system file lock is used.
- **The lock says whose it is.** It is a JSON object recording the object's `id`, the time it was taken as `lockedAt`, whether the object root existed then, and whether a remove has begun deleting. `UPDATE_IN_PROGRESS` carries `lockedAt`; whether that is too long ago is for the caller to judge. A lock file that exists refuses writers, even if it can't be read.
- **A lock is written whole.** Its content is written beside it, flushed, then hard-linked into place, so it is never half-written and only one of two writers gets it. On a filesystem without hard links it is created exclusively in place.
- **No storage layout nests object roots.** Path-direct refuses an empty `suffix`, and refuses with `ID_INCOMPATIBLE_WITH_LAYOUT` an id whose path has the suffix part-way through, such as `a/__object__/b`, comparing segments regardless of case and Unicode normalisation. So one object's lock decides who may write it. Opening, creating, updating, removing and recovering still check for an object root inside another object.
- **An out-of-date object is refused.** With the lock held, an update checks that the root inventory on disk is the one its object was opened from, before the callback runs and again before anything in the object root changes. If not, it throws `OBJECT_OUT_OF_DATE` and discards the update. A create that finds a root inventory throws `OBJECT_EXISTS`.
- **A version is assembled in a directory its writer made.** If the version's directory is already in the workspace, the update throws `RECOVERY_NEEDED` and keeps its lock, so files a dead writer left never become part of a version.

### Committing

- **An update has one commit point: the rename that replaces the root inventory.** Nothing puts a replaced root inventory back.
- **A failure before the commit point discards the update.** Everything it made is removed, including an object root and the layout directories above it that a create made. The lock is released and the original error is thrown.
- **A failure after the commit point throws `RECOVERY_NEEDED`** with the failure as its `cause`, and keeps the lock. The version stays committed.
- **A failed commit-point rename is checked against the disk.** The update is discarded only if the root inventory still names the head it started from, or, for a create, there is still no root inventory. Anything else is treated as committed, including a root inventory that can't be read or names no head.
- **A failure to discard throws `RECOVERY_NEEDED`** too, with the update's own failure as its `cause`, and keeps the lock.
- **A create that isn't committed is not an object yet.** While an object root has a declaration, no root inventory and a held lock, `root.open` throws `OBJECT_NOT_FOUND`, `root.create` throws `UPDATE_IN_PROGRESS`, and listing leaves it out. Without the lock that state is damage: `root.open` throws `INVALID_OBJECT` and `root.create` throws `OBJECT_EXISTS`.
- **A remove is committed when its lock says so.** With the lock held, `root.remove` checks that the id's directory holds that object, and if not releases the lock and deletes nothing. Otherwise it records in the lock that the object is being removed, and only then deletes. From there the remove is carried through, by `root.remove` or by recovery: a failure throws `RECOVERY_NEEDED` and keeps the lock. The declaration, root inventory and sidecar go last, so a reader meanwhile finds the object, not a damaged one.

### Recovering

- **Held locks are listed as unfinished writes.** `root.unfinishedWrites()` gives one for each lock in the workspace that can be read and sits where the layout places its id, with its `id`, `lockedAt` and whether it is `removing`. `root.unfinishedWrite(id)` finds the one for an id. Listing changes nothing, and can't say which writers are dead.
- **An object is recovered only through its unfinished write**, on the caller's word that its writer is dead. There is no recovery by id alone and none of every lock at once: after one host crashes, writers on other hosts may still be alive.
- **Recovering is checked against the writer.** `write.recover()` acts only if the lock is still the listed writer's; a writer that has since begun removing the object is still the same writer. If another writer's lock has replaced it, it throws `UPDATE_IN_PROGRESS` and changes nothing. If the lock has gone, it does nothing.
- **Recovery applies the commit-point rule, and removes only what a dead writer can have left:**
  - in the workspace, the version being assembled, unless another lock is inside it, and a lock's content file that was never linked into place;
  - with a root inventory, inventory files not yet renamed into place and the directory of the version after the head. A missing or out-of-date sidecar is written, which completes a committed update;
  - with no root inventory, the create wasn't committed. Its declaration, first version and inventory files are removed, and so are the object root and the empty layout directories above it if the lock says the create made them;
  - with a lock that says the object is being removed, the rest of the object root is deleted;
  - with an object root that holds another id's object, or is inside another object, nothing in the object root: its writer was refused before writing there.

  Anything else is left alone, and recovery never makes a version the head. A declaration with no root inventory and a version other than the first is damage, not a dead create: recovery throws `INVALID_OBJECT` and changes nothing. The lock is released last.

## Consequences

- Retrying is the caller's choice. After `UPDATE_IN_PROGRESS` it can wait and try again. After `OBJECT_OUT_OF_DATE` it opens the object again and repeats the update.
- A slow writer is never trampled, however long it takes. Readers take no lock, so opening an object never waits on a writer.
- A writer that dies leaves its lock, and the object can't be written until someone who knows the writer is dead recovers its unfinished write. `lockedAt` is all the library offers towards that call. It is the writer's own clock, so it compares across hosts only as far as their clocks agree.
- After a crash the caller lists the unfinished writes, whatever the layout, and recovers the ones it judges dead.
- Recovering a write whose writer is still alive destroys that writer's update and lets a second writer in beside it. Two recoveries of one write at once are not kept apart either.
- "Was the update committed?" has one answer, which the root inventory on disk gives. Any error but `RECOVERY_NEEDED` means it wasn't, and the update can be repeated.
- After `RECOVERY_NEEDED` the update may or may not be committed, and the caller must not simply repeat it. The object stays readable and locked. The caller recovers its unfinished write, opens the object again, and repeats the update only if the head hasn't moved. After `RECOVERY_NEEDED` from a remove, the object may still open with files missing until recovery deletes the rest.
- A lost rename reply costs a recovery, not a version.
- Recovery can be repeated: if it fails part-way the lock is still there.
- Between the commit point and the sidecar's replacement the root inventory doesn't match its sidecar. Opening an object allows for that: it accepts a root inventory identical to the head version's own inventory.
- Recovery can't destroy a committed version. A damaged object that has lost its root inventory keeps every version directory.
- Another tool writing the same object isn't kept apart by the lock. It is caught only if it has moved the head by the time the update checks.
- A lock removed by hand leaves no unfinished write, so what its writer left can't be recovered. A version left in the workspace turns the next create or update into an unfinished write, and the next remove deletes it. An uncommitted create's object root has to be removed by hand.
- On a filesystem without hard links, a crash while a lock is written can leave a file the library doesn't recognise as a lock. It refuses writers but is no unfinished write, so it has to be removed by hand.
- A path-direct storage root whose `config.json` sets an empty `suffix` can't be opened, even to read. Ids where one only starts with another, such as `a` and `a/b`, are stored side by side.
- An object root inside another object is reported, not written: `INVALID_OBJECT` (E082) if it holds an object, `ID_INCOMPATIBLE_WITH_LAYOUT` on a create there.
