import { OcflError } from './error.ts';
import type { OcflObject } from './object.ts';

export interface FileRef {
  /** Actual path to the file location relative to the ocfl object root. */
  contentPath?: string;
  /** A path that represents a file’s location in the logical state of an object. */
  logicalPath?: string;
  /** An algorithmic characterization of the contents of a file conforming to a standard digest algorithm. */
  digest?: string;
  /** Version of the OCFL object. */
  version?: string | undefined;
  /** Last modified time of the file, in milliseconds since the UNIX epoch. */
  lastModified?: number;
  /** Size of the file in bytes. */
  size?: number;
  /** Fixity information of the file. */
  fixity?: { [algorithm: string]: string };
}

export interface FileStat {
  /** Size of the file in bytes. */
  size?: number;
  /** Last access time of the file. */
  atime?: Date;
  /** Last modified time of the file. */
  mtime?: Date;
  /** Creation time of the file. */
  ctime?: Date;
}

const REF_KEYS = ['logicalPath', 'version', 'digest', 'contentPath'] as const;

/**
 * Represent a file in an OCFL object
 */
class OcflObjectFile {
  #ocflObject: OcflObject;
  #lastModified: number | undefined;
  #size: number | undefined;
  logicalPath?: string;
  contentPath?: string;
  digest?: string;
  version?: string;
  fixity?: { [algorithm: string]: string };

  constructor(ocflObject: OcflObject, fileRef: FileRef) {
    this.#ocflObject = ocflObject;
    if (fileRef.logicalPath) {
      this.logicalPath = fileRef.logicalPath;
    }
    if (fileRef.contentPath) {
      this.contentPath = fileRef.contentPath;
    }
    if (fileRef.digest) {
      this.digest = fileRef.digest;
    }
    if (fileRef.version) {
      this.version = fileRef.version;
    }
    if (fileRef.lastModified != null) {
      this.#lastModified = fileRef.lastModified;
    }
    if (fileRef.size != null) {
      this.#size = fileRef.size;
    }
    if (fileRef.fixity != null) {
      this.fixity = fileRef.fixity;
    }
  }

  /**
   * Resolve contentPath given either the `logicalPath` and `version`, `digest`, or `contentPath`.
   */
  async #resolveContentPath(): Promise<string> {
    let contentPath = this.contentPath;
    if (!contentPath) {
      const inv = await this.#ocflObject._requireInventory();
      const version = !this.version || this.version === 'latest' ? inv.head : this.version;
      contentPath = this.digest ? inv.getContentPath(this.digest) : this.logicalPath && inv.getFile(this.logicalPath, version)?.contentPath;
      if (!contentPath) {
        throw new OcflError(
          'FILE_NOT_FOUND',
          `Cannot find content "${this.toString()}" in the OCFL Object "${this.#ocflObject.id}" version "${this.version || 'latest'}"`,
        );
      }
    }
    return contentPath;
  }

  /**
   * Returns the last modified time of the file, in millisecond since the UNIX epoch (January 1st, 1970 at Midnight).
   */
  get lastModified() {
    return this.#lastModified;
  }

  /**
   * Returns the file size in bytes.
   */
  get size() {
    return this.#size;
  }

  toString() {
    const props = REF_KEYS.filter((key) => this[key]).map((key) => `${key}: '${this[key]}'`);
    return `{ ${props.join(', ')} }`;
  }

  /**
   * Get the file content as a buffer
   * @param options Options to be passed to underlying data store specific implementation
   */
  async buffer(options?: unknown): Promise<Uint8Array> {
    return this.#ocflObject.readFile(await this.#resolveContentPath(), options);
  }

  /**
   * @deprecated Use {@link OcflObjectFile.buffer}
   */
  async asBuffer(options?: unknown) {
    return this.buffer(options);
  }

  /**
   * Get the file content as a string
   * @param encoding String encoding, default to utf8
   */
  async text(encoding: BufferEncoding = 'utf8'): Promise<string> {
    return this.#ocflObject.readFile(await this.#resolveContentPath(), encoding);
  }

  /**
   * @deprecated Use {@link OcflObjectFile.text}
   */
  async asString(encoding: BufferEncoding = 'utf8') {
    return this.text(encoding);
  }

  /**
   * Get the file content as a ReadableStream
   * @param options Options to be passed to underlying data store specific implementation
   * @deprecated Use {@link OcflObjectFile.stream}
   */
  async asStream(options?: unknown): Promise<ReadableStream> {
    return this.stream(options);
  }

  /**
   * Get the file content as a ES Streams standard ReadableStream
   * @param options Options to be passed to underlying data store specific implementation
   */
  async stream(options?: unknown): Promise<ReadableStream> {
    return this.#ocflObject.createReadable(await this.#resolveContentPath(), options);
  }

  /**
   * Get the file stat info
   */
  async stat(_options?: unknown): Promise<FileStat> {
    return this.#ocflObject.stat(await this.#resolveContentPath());
  }
}

export { OcflObjectFile };
