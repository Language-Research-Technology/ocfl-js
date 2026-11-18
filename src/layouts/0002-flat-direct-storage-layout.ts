import path from 'node:path';
import { OCFL_CONSTANTS } from '../constants.ts';
import { hasOverlongSegment, MAX_NAME_BYTES } from '../file-system.ts';
import { BuiltInLayout } from './built-in-layout.ts';

/** Object roots named by their id, directly in the storage root. */
export interface FlatDirectLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0002-flat-direct-storage-layout';
}

const { EXTENSIONS_DIR } = OCFL_CONSTANTS;

/**
 * OCFL object identifiers are mapped directly to directory names that are direct children of the OCFL storage root directory.
 */
export class FlatDirectStorageLayout extends BuiltInLayout {
  readonly name = '0002-flat-direct-storage-layout';
  readonly description = 'OCFL object identifiers are mapped directly to directory names that are direct children of the OCFL storage root.';

  map(id: string): string {
    let reason: string | undefined;
    if (path.basename(id) !== id) {
      reason = 'it contains the path separator character';
    } else if (id === '.' || id === '..') {
      reason = 'it is the storage root or its parent';
    } else if (id === EXTENSIONS_DIR) {
      reason = 'it conflicts with the extensions directory';
    } else if (hasOverlongSegment(id)) {
      reason = `it is longer than ${MAX_NAME_BYTES} bytes in UTF-8`;
    }
    if (reason) {
      throw this.incompatibleId(id, reason);
    }

    return id;
  }
}
