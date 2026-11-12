import type * as entryPoint from '../../src/index.ts';
import type {
  ByteRange,
  ContentAlgorithm,
  Draft,
  FixityProblem,
  FlatDirectLayoutConfig,
  HashAndIdNTupleLayoutConfig,
  HashedNTupleLayoutConfig,
  Layout,
  LayoutConfig,
  OcflErrorCode,
  OcflFile,
  OcflObject,
  OcflVersion,
  PathDirectLayoutConfig,
  StorageRoot,
  UnfinishedWrite,
  User,
  Version,
  VersionDetails,
  WriteContent,
} from '../../src/index.ts';

export type EveryExportedType = [
  ByteRange,
  ContentAlgorithm,
  Draft,
  FixityProblem,
  FlatDirectLayoutConfig,
  HashAndIdNTupleLayoutConfig,
  HashedNTupleLayoutConfig,
  Layout,
  LayoutConfig,
  OcflErrorCode,
  OcflFile,
  OcflObject,
  OcflVersion,
  PathDirectLayoutConfig,
  StorageRoot,
  UnfinishedWrite,
  User,
  Version,
  VersionDetails,
  WriteContent,
];

export type NoInternalIsExported = [
  // @ts-expect-error not exported
  entryPoint.OcflStorage,
  // @ts-expect-error not exported
  entryPoint.OcflStorageConfig,
  // @ts-expect-error not exported
  entryPoint.OcflObjectTransaction,
  // @ts-expect-error not exported
  entryPoint.OcflObjectInventory,
  // @ts-expect-error not exported
  entryPoint.Inventory,
  // @ts-expect-error not exported
  entryPoint.ValidationError,
  // @ts-expect-error not exported
  entryPoint.ObjectNotFoundError,
  // @ts-expect-error not reachable: layouts are chosen by config
  entryPoint.OcflStorageLayout,
  // @ts-expect-error there is no default export
  entryPoint.default,
];
