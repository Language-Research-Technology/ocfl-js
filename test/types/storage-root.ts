import {
  createStorageRoot,
  type DigestAlgorithm,
  type FixityAlgorithm,
  type Layout,
  type LayoutConfig,
  type ListedDamagedObjectRoot,
  type ListedOpenedObject,
  type OcflErrorCode,
  type OcflObject,
  openStorageRoot,
  type StorageRoot,
  type UnfinishedWrite,
} from '../../src/index.ts';

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

export function hashedLayoutsTakeOnlySupportedFixityAlgorithms(
  path: string,
  algorithm: FixityAlgorithm,
  objectAlgorithm: DigestAlgorithm,
): Promise<StorageRoot>[] {
  const everyName: FixityAlgorithm[] = ['md5', 'sha1', 'sha256', 'sha512', 'sha512/256', 'blake2b-512'];
  return [
    ...everyName.map((digestAlgorithm) => createStorageRoot(path, { layout: { extensionName: '0004-hashed-n-tuple-storage-layout', digestAlgorithm } })),
    createStorageRoot(path, { layout: { extensionName: '0003-hash-and-id-n-tuple-storage-layout', digestAlgorithm: algorithm } }),
    createStorageRoot(path, { layout: { extensionName: '0004-hashed-n-tuple-storage-layout', digestAlgorithm: objectAlgorithm } }),
    // @ts-expect-error a typo is caught before run time
    createStorageRoot(path, { layout: { extensionName: '0003-hash-and-id-n-tuple-storage-layout', digestAlgorithm: 'sha265' } }),
    // @ts-expect-error a typo is caught before run time
    createStorageRoot(path, { layout: { extensionName: '0004-hashed-n-tuple-storage-layout', digestAlgorithm: 'SHA256' } }),
  ];
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

export function replacePairsAreReadOnly(layout: Layout): void {
  if (layout.extensionName === '000N-path-direct-storage-layout') {
    // @ts-expect-error read-only
    layout.replace.push(['a', 'b']);
    const [first] = layout.replace;
    if (first) {
      // @ts-expect-error read-only
      first[1] = 'b';
    }
  }
}

export function replacePairsCanBeAnyArrayOfPairs(
  path: string,
  readOnly: readonly (readonly [string, string])[],
  mutable: [string, string][],
): Promise<StorageRoot>[] {
  return [
    createStorageRoot(path, { layout: { extensionName: '000N-path-direct-storage-layout', replace: readOnly } }),
    createStorageRoot(path, { layout: { extensionName: '000N-path-direct-storage-layout', replace: mutable } }),
  ];
}

/** Narrowing on the extension name gives that layout's parameters, all present */
export function layoutNarrowsByName(layout: Layout): number | string {
  if (layout.extensionName === '0004-hashed-n-tuple-storage-layout') {
    const tupleSize: number = layout.tupleSize;
    return tupleSize;
  }
  if (layout.extensionName === '0003-hash-and-id-n-tuple-storage-layout') {
    const digestAlgorithm: FixityAlgorithm = layout.digestAlgorithm;
    return digestAlgorithm;
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

export async function listedObjectsMustBeNarrowed(root: StorageRoot): Promise<void> {
  for await (const entry of root.objects()) {
    // @ts-expect-error a damaged object root has no object
    entry.object.id;
    switch (entry.status) {
      case 'opened': {
        const opened: ListedOpenedObject = entry;
        const object: OcflObject = entry.object;
        // @ts-expect-error an object has no error
        entry.error;
        void [opened, object];
        break;
      }
      case 'damaged': {
        const damaged: ListedDamagedObjectRoot = entry;
        const code: OcflErrorCode = entry.error.code;
        const objectRoot: string = entry.objectRoot;
        const id: string | undefined = entry.id;
        // @ts-expect-error read-only
        entry.objectRoot = 'elsewhere';
        // @ts-expect-error read-only
        entry.status = 'opened';
        void [damaged, code, objectRoot, id];
        break;
      }
      default: {
        const unknown: never = entry;
        void unknown;
      }
    }
  }
}

export function anUnfinishedWriteNamesItsOperation(write: UnfinishedWrite): string {
  const operation: 'create' | 'update' | 'purge' = write.operation;
  // @ts-expect-error read-only
  write.operation = 'update';
  // @ts-expect-error whether a purge had begun deleting is not public
  void write.removing;
  return operation;
}

export async function anObjectIsPurgedNotRemoved(root: StorageRoot): Promise<void> {
  await root.purge('id');
  // @ts-expect-error renamed purge
  await root.remove('id');
}
