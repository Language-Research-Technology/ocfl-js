import { createStorageRoot, type LayoutConfig, OcflError, type StorageRoot } from '../../src/index.ts';

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

// A new code can arrive in a minor release
export function describeError(error: OcflError): string {
  switch (error.code) {
    case 'OBJECT_NOT_FOUND':
      return 'There is no such object';
    case 'UPDATE_IN_PROGRESS':
      return 'Another writer is updating the object';
    default:
      throw error;
  }
}
