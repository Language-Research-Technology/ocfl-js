import type { OcflStorageConfig } from '../src/index.ts';

// A consumer with exactOptionalPropertyTypes forwarding its own optional settings
export function storageConfig(root: string, layout?: OcflStorageConfig['layout']): OcflStorageConfig {
  return { root, layout };
}

export function pinNoFixityAlgorithms(root: string): OcflStorageConfig {
  // @ts-expect-error fixity values are no longer written
  return { root, fixityAlgorithms: ['md5'] };
}
