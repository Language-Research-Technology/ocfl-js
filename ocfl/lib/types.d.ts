
type OcflExtensionCreate = <T extends typeof import('./extension').OcflExtension>(this: T, config?: OcflExtensionConfig) => InstanceType<T>;


// import { Abortable } from "events";
// import { ObjectEncodingOptions, OpenMode, PathLike } from "fs";
// import { FileHandle } from "fs/promises";
type OpenMode = number | string;

interface ReadFile {
  /**
   * Provide a common interface to read a file inside an object. 
   * A concrete subclass MAY implement this method to provide read access to its underlying storage backend.
   * The default implementation uses the {@linkcode OcflStore#createReadStream} method.
   * @param path - The absolute path of the file to be read.
   * @param options - Options to be passed to the underlying method
   */
  readFile(
    filePath: string,
    options?:
      | {
        encoding?: null | undefined;
        flag?: OpenMode | undefined;
      }
      | null
  ): Promise<Buffer>;

  /**
   * Provide a common interface to read a file inside an object. 
   * A concrete subclass MAY implement this method to provide read access to its underlying storage backend.
   * The default implementation uses the {@linkcode OcflStore#createReadStream} method.
   * @param path - The absolute path of the file to be read.
   * @param options - Options to be passed to the underlying method
   */
  readFile(
    filePath: string,
    options:
      | {
        encoding: BufferEncoding;
        flag?: OpenMode | undefined;
      }
      | BufferEncoding
  ): Promise<string>;
}

type StorageLayout = {
  FlatDirectStorageLayout: typeof import('./extensions/0002-flat-direct-storage-layout').FlatDirectStorageLayout
  HashAndIdNTupleStorageLayout: typeof import('./extensions/0003-hash-and-id-n-tuple-storage-layout').HashAndIdNTupleStorageLayout
  HashedNTupleStorageLayout: typeof import('./extensions/0004-hashed-n-tuple-storage-layout').HashedNTupleStorageLayout
  FlatOmitPrefixStorageLayout: typeof import('./extensions/0006-flat-omit-prefix-storage-layout').FlatOmitPrefixStorageLayout
  NTupleOmitPrefixStorageLayout: typeof import('./extensions/0007-n-tuple-omit-prefix-storage-layout').NTupleOmitPrefixStorageLayout
  PathDirectStorageLayout: typeof import('./extensions/000N-path-direct-storage-layout').PathDirectStorageLayout
}
