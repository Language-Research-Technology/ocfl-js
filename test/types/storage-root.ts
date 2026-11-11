import { createStorageRoot, type Layout, type LayoutConfig, openStorageRoot, type StorageRoot } from '../../src/index.ts';

export async function layoutIsRequired(path: string): Promise<void> {
  // @ts-expect-error the layout is required
  await createStorageRoot(path);
  // @ts-expect-error the layout is required
  await createStorageRoot(path, {});
  // @ts-expect-error a bare extension name is not a layout config
  await createStorageRoot(path, { layout: '0004-hashed-n-tuple-storage-layout' });
  // @ts-expect-error a parameter of another layout
  await createStorageRoot(path, { layout: { extensionName: '0002-flat-direct-storage-layout', tupleSize: 2 } });
}

export async function openTakesOnlyAPath(path: string): Promise<void> {
  // @ts-expect-error a storage root is opened with the layout it declares
  await openStorageRoot(path, { layout: { extensionName: '0002-flat-direct-storage-layout' } });
}

export function storageRootIsReadOnly(root: StorageRoot): void {
  // @ts-expect-error read-only
  root.path = '/elsewhere';
  // @ts-expect-error read-only
  root.ocflVersion = '1.0';
  // @ts-expect-error read-only
  root.layout = { extensionName: '0002-flat-direct-storage-layout' };
  // @ts-expect-error read-only
  root.layout.extensionName = '0002-flat-direct-storage-layout';
}

/** Narrowing on the extension name gives that layout's parameters, all present */
export function layoutNarrowsByName(layout: Layout): number | string {
  if (layout.extensionName === '0004-hashed-n-tuple-storage-layout') {
    const tupleSize: number = layout.tupleSize;
    return tupleSize;
  }
  if (layout.extensionName === '000N-path-direct-storage-layout') {
    const suffix: string = layout.suffix;
    return suffix;
  }
  return layout.extensionName;
}

// A consumer with exactOptionalPropertyTypes can pass a storage root's layout back to create another like it
export function createLike(path: string, root: StorageRoot): Promise<StorageRoot> {
  const layout: LayoutConfig = root.layout;
  return createStorageRoot(path, { layout });
}
