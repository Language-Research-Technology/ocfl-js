import { createStorageRoot, type LayoutConfig, OcflError, type OcflErrorCode, type StorageRoot } from '../../src/index.ts';

// A consumer with exactOptionalPropertyTypes keeping the layout in its own config and forwarding it
interface ConsumerConfig {
  path: string;
  layout: LayoutConfig;
  label?: string;
}

export function createFromConfig(config: ConsumerConfig): Promise<StorageRoot> {
  return createStorageRoot(config.path, { layout: config.layout });
}

export function configFor(path: string, layout: LayoutConfig, label?: string): ConsumerConfig {
  return label === undefined ? { path, layout } : { path, layout, label };
}

export function onlyTheLibraryMakesItsErrors(): OcflError {
  // @ts-expect-error the constructor is private
  return new OcflError('OBJECT_NOT_FOUND', 'missing');
}

// Fails to compile when a code is added or removed without this list changing
export function everyCodeIsHandled(code: OcflErrorCode): string {
  switch (code) {
    case 'OBJECT_NOT_FOUND':
    case 'OBJECT_EXISTS':
    case 'OBJECT_OUT_OF_DATE':
    case 'INVALID_OBJECT':
    case 'INVALID_STORAGE_ROOT':
    case 'UNSUPPORTED_LAYOUT':
    case 'ID_INCOMPATIBLE_WITH_LAYOUT':
    case 'DIRECTORY_NOT_EMPTY':
    case 'UPDATE_IN_PROGRESS':
    case 'RECOVERY_NEEDED':
    case 'MUTABLE_HEAD_ACTIVE':
    case 'CROSS_FILESYSTEM_MOVE':
    case 'VERSION_LIMIT_REACHED':
    case 'FILE_NOT_FOUND':
    case 'FILE_EXISTS':
    case 'INVALID_LOGICAL_PATH':
    case 'SOURCE_CHANGED':
    case 'UNSUPPORTED_FILE_TYPE':
      return code;
    default:
      return code satisfies never;
  }
}

export function nothingElseIsACode(): OcflErrorCode[] {
  // @ts-expect-error not a code
  const notLoaded: OcflErrorCode = 'OBJECT_NOT_LOADED';
  // @ts-expect-error not a code
  const notAnObject: OcflErrorCode = 'NOT_AN_OBJECT';
  // @ts-expect-error not a code
  const invalidPath: OcflErrorCode = 'INVALID_PATH';
  // @ts-expect-error not a code
  const invalidLayoutConfig: OcflErrorCode = 'INVALID_LAYOUT_CONFIG';
  // @ts-expect-error an OCFL validation code is the `ocflCode`, not the `code`
  const validationCode: OcflErrorCode = 'E060';
  return [notLoaded, notAnObject, invalidPath, invalidLayoutConfig, validationCode];
}
