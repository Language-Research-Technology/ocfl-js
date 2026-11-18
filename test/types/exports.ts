import type * as entryPoint from '../../src/index.ts';
import type {
  CreateOptions,
  DigestAlgorithm,
  Draft,
  ExportOptions,
  ExportProgress,
  FixityAlgorithm,
  FixityOptions,
  FixityProblem,
  FixityProgress,
  FlatDirectLayoutConfig,
  HashAndIdNTupleLayoutConfig,
  HashedNTupleLayoutConfig,
  ImportOptions,
  Layout,
  LayoutConfig,
  ListedDamagedObjectRoot,
  ListedObject,
  ListedOpenedObject,
  MergeOptions,
  OcflErrorCode,
  OcflFile,
  OcflObject,
  OcflSpecVersion,
  PathDirectLayoutConfig,
  StorageRoot,
  StreamOptions,
  UnfinishedWrite,
  UpdateOptions,
  User,
  Version,
  VersionDetails,
  WriteContent,
} from '../../src/index.ts';

export type EveryExportedType = [
  CreateOptions,
  DigestAlgorithm,
  Draft,
  ExportOptions,
  ExportProgress,
  FixityAlgorithm,
  FixityOptions,
  FixityProblem,
  FixityProgress,
  FlatDirectLayoutConfig,
  HashAndIdNTupleLayoutConfig,
  HashedNTupleLayoutConfig,
  ImportOptions,
  Layout,
  LayoutConfig,
  ListedDamagedObjectRoot,
  ListedObject,
  ListedOpenedObject,
  MergeOptions,
  OcflErrorCode,
  OcflFile,
  OcflObject,
  OcflSpecVersion,
  PathDirectLayoutConfig,
  StorageRoot,
  StreamOptions,
  UnfinishedWrite,
  UpdateOptions,
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
  entryPoint.ObjectDraft,
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
  // @ts-expect-error renamed OcflSpecVersion
  entryPoint.OcflVersion,
  // @ts-expect-error there is no default export
  entryPoint.default,
];
