
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
