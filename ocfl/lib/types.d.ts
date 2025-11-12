
//type OcflExtensionCreate = <T extends typeof import('./extension').OcflExtension>(this: T, config?: OcflExtensionConfig) => InstanceType<T>;


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

interface InventoryDigests {
  [key:string]: string[];
}

interface InventoryVersion {
  created: string;
  message?: string;
  state: InventoryDigests;
  user?: {
    name: string;
    address?: string;
  };
}

interface Inventory {
  /** A unique identifier for the OCFL Object. */
  id: string;
  /** The URI of the inventory section of the specification version matching the object conformance declaration. */
  type: 'https://ocfl.io/1.0/spec/#inventory' | 'https://ocfl.io/1.1/spec/#inventory';
  /** 
   * The algorithm used for calculating digests for content-addressing 
   * within the OCFL Object and for the Inventory Digest. 
   * This MUST be the algorithm used in the manifest and state blocks 
   */
  digestAlgorithm: 'sha256' | 'sha512';
  /** The version directory name of the most recent version of the object. */
  head: string;
  manifest: InventoryDigests;
  versions: {
    [key:string]: InventoryVersion;
  };
  fixity?: {
    [key in 'md5'|'sha1'|'sha256'|'sha512'|'blake2b-512']: {};
  };
  /** 
   * The name of the designated content directory within the version directories.
   * @default content
   */
  contentDirectory?: string;
}

//type Enum<T extends readonly string[]> = {[key in T[number]]: ReturnType<typeof enumeration<T>>};
//declare function enumeration<T extends readonly string[]>(arr:  T): Enum<T>;
