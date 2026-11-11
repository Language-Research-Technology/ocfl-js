import path from 'node:path';
import { OcflConstants } from '../constants.ts';
import { ocflError } from '../error.ts';
import { BuiltInLayout } from '../extension.ts';

const { EXTENSIONS_DIR } = OcflConstants;

/**
 * OCFL object identifiers are mapped directly to directory names that are direct children of the OCFL storage root directory.
 */
class FlatDirectStorageLayout extends BuiltInLayout {
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
    } else if (id.length > 255) {
      reason = 'it has more than 255 characters';
    }
    if (reason) {
      throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `The object id <${id}> is incompatible with layout extension ${this.name} because ${reason}.`);
    }

    return id;
  }
}

export { FlatDirectStorageLayout };
