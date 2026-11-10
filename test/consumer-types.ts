import type { OcflStorageConfig } from '../src/index.ts';

// A consumer with exactOptionalPropertyTypes forwarding its own optional settings
export function storageConfig(root: string, layout?: OcflStorageConfig['layout'], workspace?: string): OcflStorageConfig {
  return { root, layout, workspace };
}
