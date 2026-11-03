import type { OcflStorageConfig } from '@ocfl/ocfl';

// A consumer with exactOptionalPropertyTypes forwarding its own optional settings
export function storageConfig(root: string, layout?: string, workspace?: string): OcflStorageConfig {
  return { root, layout, workspace };
}
