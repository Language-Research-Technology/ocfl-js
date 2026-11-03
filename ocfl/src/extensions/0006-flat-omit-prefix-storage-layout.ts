import { OcflStorageLayout } from '../extension.ts';

class FlatOmitPrefixStorageLayout extends OcflStorageLayout {
  static get NAME() {
    return '0006-flat-omit-prefix-storage-layout';
  }
}

export { FlatOmitPrefixStorageLayout };
