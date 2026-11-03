export { PathDirectStorageLayout } from './000N-path-direct-storage-layout.ts';
export { FlatDirectStorageLayout } from './0002-flat-direct-storage-layout.ts';
export { HashAndIdNTupleStorageLayout } from './0003-hash-and-id-n-tuple-storage-layout.ts';
export { HashedNTupleStorageLayout } from './0004-hashed-n-tuple-storage-layout.ts';
export { FlatOmitPrefixStorageLayout } from './0006-flat-omit-prefix-storage-layout.ts';
export { NTupleOmitPrefixStorageLayout } from './0007-n-tuple-omit-prefix-storage-layout.ts';
export { DigestAlgorithm } from './0009-digest-algorithms.ts';

import type { PathDirectStorageLayout } from './000N-path-direct-storage-layout.ts';
import type { FlatDirectStorageLayout } from './0002-flat-direct-storage-layout.ts';
import type { HashAndIdNTupleStorageLayout } from './0003-hash-and-id-n-tuple-storage-layout.ts';
import type { HashedNTupleStorageLayout } from './0004-hashed-n-tuple-storage-layout.ts';
import type { FlatOmitPrefixStorageLayout } from './0006-flat-omit-prefix-storage-layout.ts';
import type { NTupleOmitPrefixStorageLayout } from './0007-n-tuple-omit-prefix-storage-layout.ts';

/** Built-in storage layout classes, keyed by class name */
export type StorageLayout = {
  FlatDirectStorageLayout: typeof FlatDirectStorageLayout;
  FlatOmitPrefixStorageLayout: typeof FlatOmitPrefixStorageLayout;
  HashAndIdNTupleStorageLayout: typeof HashAndIdNTupleStorageLayout;
  HashedNTupleStorageLayout: typeof HashedNTupleStorageLayout;
  NTupleOmitPrefixStorageLayout: typeof NTupleOmitPrefixStorageLayout;
  PathDirectStorageLayout: typeof PathDirectStorageLayout;
};
