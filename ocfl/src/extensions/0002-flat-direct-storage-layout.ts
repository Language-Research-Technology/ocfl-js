import path from 'node:path';
import { OcflConstants } from '../constants.ts';
import { OcflStorageLayout } from '../extension.ts';

const { EXTENSIONS_DIR } = OcflConstants;

let instance: FlatDirectStorageLayout;

/**
 * OCFL object identifiers are mapped directly to directory names that are direct children of the OCFL storage root directory.
 */
class FlatDirectStorageLayout extends OcflStorageLayout {
  static get NAME() {
    return '0002-flat-direct-storage-layout';
  }
  static get DESCRIPTION() {
    return 'OCFL object identifiers are mapped directly to directory names' + ' that are direct children of the OCFL storage root.';
  }

  static create<T>(): T {
    instance ??= new FlatDirectStorageLayout();
    return instance as T;
  }

  map(id: string): string {
    if (path.basename(id) !== id) {
      throw new Error(`The object id <${id}> is incompatible with layout extension ${this.name} because it contains the path separator character.`);
    } else if (id === EXTENSIONS_DIR) {
      throw new Error(`The object id <${id}> is incompatible with layout extension ${this.name} because it conflicts with the extensions directory.`);
    }
    if (id.length > 255) {
      throw new Error(`The object id <${id}> is incompatible with layout extension ${this.name} because it has more than 255 characters.`);
    }

    return id;
  }
}

export { FlatDirectStorageLayout };
