import { OcflStorageLayout } from '../extension.ts';

class NTupleOmitPrefixStorageLayout extends OcflStorageLayout {
  static get NAME() {
    return '0007-n-tuple-omit-prefix-storage-layout';
  }
}

export { NTupleOmitPrefixStorageLayout };
