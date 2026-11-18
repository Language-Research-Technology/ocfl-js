# Opening a storage root, or creating it if it isn't there

There is no `openOrCreateStorageRoot`, and `createStorageRoot` has no option to open a storage root that is already there.

## Why this is out of scope

Creating a storage root is a deliberate, one-off act: the caller knows there is nothing there and chooses its storage layout. After that, every caller opens it. The two steps don't need to be one call.

Combining them would cost more than the few lines it saves. The caller passes a storage layout, so the function must decide what happens when the existing storage root declares a different one, or the same one with different parameters. Opening it anyway hides a misconfiguration, which [ADR 0007](../docs/adr/0007-faults-are-refused-never-worked-around.md) rules out; refusing it needs a new error code and a comparison of every parameter. No known consumer needs either.

A caller who does want both catches `STORAGE_ROOT_NOT_FOUND` from `openStorageRoot` and calls `createStorageRoot`, as the errors guide shows:

```ts
try {
  return await openStorageRoot(path);
} catch (error) {
  if (!(error instanceof OcflError && error.code === 'STORAGE_ROOT_NOT_FOUND')) throw error;
  return createStorageRoot(path, { layout });
}
```

## Prior requests

- #402: "Open a storage root, creating it if it isn't there"
