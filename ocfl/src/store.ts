import type { Dir, Stats } from 'node:fs';
import path from 'node:path';
import { isNotFound, joinTypedArray } from './utils.ts';

const emptyOptions = {};

type Encoding = BufferEncoding | { encoding: BufferEncoding };

export type WriteFileData = string | Uint8Array | DataView | ArrayBuffer | ReadableStream;

export interface ListedFile {
  name: string;
  path: string;
  size: number;
  lastModified: Date;
}

export interface ListOptions {
  encoding?: BufferEncoding;
  bufferSize?: number;
  recursive?: boolean;
}

/**
 * Abstract class to provide common APIs to access and modify the actual data store backend
 * such as local file system and cloud storage
 */
class OcflStore {
  static instances: Map<object, OcflStore>;

  static getInstance<T extends OcflStore>(this: new (options?: object) => T, options: object = emptyOptions): T {
    // biome-ignore lint/complexity/noThisInStatic: reads the subclass's own instances map
    const instances = (this as unknown as typeof OcflStore).instances as Map<object, T> | undefined;
    if (!instances) {
      return new this(options);
    }
    let store = instances.get(options);
    if (!store) {
      store = new this(options);
      instances.set(options, store);
    }
    return store;
  }

  // biome-ignore lint/complexity/noUselessConstructor: documents the constructor signature subclasses receive from getInstance()
  constructor(_options?: object) {}

  /**
   * Get file information.
   */
  async stat(_filePath: string): Promise<Stats> {
    throw new Error('Not Implemented');
  }

  /**
   * Check if file exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a ReadableStream to get the content of a file
   * @param filePath - Absolute path
   */
  async createReadable(_filePath: string, _options?: unknown): Promise<ReadableStream> {
    throw new Error('Not Implemented');
  }

  /**
   * Create a WritableStream that writes data to `filePath`.
   */
  async createWritable(_filePath: string, _options?: unknown): Promise<WritableStream> {
    throw new Error('Not Implemented');
  }

  /**
   * Provide a common interface to read a file inside an object.
   * A concrete subclass MAY implement this method to provide read access to its underlying storage backend.
   * The default implementation uses the {@linkcode OcflStore#createReadable} method.
   */
  async readFile(filePath: string, options: Encoding): Promise<string>;
  async readFile(filePath: string, options?: unknown): Promise<Uint8Array>;
  async readFile(filePath: string, options?: unknown): Promise<string | Uint8Array> {
    const rs = await this.createReadable(filePath, options);
    let buffer: string | Uint8Array =
      typeof options === 'string' || (options as { encoding?: string } | undefined)?.encoding
        ? ''
        : new Uint8Array(new ArrayBuffer(0, { maxByteLength: 16 * 1024 }));
    for await (const chunk of rs) {
      if (typeof chunk === 'string') {
        if (typeof buffer !== 'string') {
          buffer = new TextDecoder().decode(buffer);
        }
        buffer += chunk;
      } else {
        if (typeof buffer === 'string') {
          buffer = new TextEncoder().encode(buffer);
        }
        buffer = joinTypedArray(buffer, chunk) as Uint8Array;
      }
    }
    return buffer;
  }

  /**
   * Provide a common interface to write a file inside an object.
   * A concrete subclass MAY implement this method to provide write access to its underlying storage backend.
   * The default implementation uses the {@link OcflStore.createWritable} method.
   * @param filePath - Absolute path to the file.
   * @param data - The data to be written to the file.
   */
  async writeFile(filePath: string, data: WriteFileData, options?: object | string): Promise<void> {
    await this.mkdir(path.dirname(filePath));
    const target = await this.createWritable(filePath, options);
    if (data instanceof ReadableStream) {
      await data.pipeTo(target);
    } else {
      const w = target.getWriter();
      await w.write(data);
      await w.close();
    }
  }

  /**
   * Copy file from `source` to `target`.
   * By default, target is overwritten if it already exists.
   */
  async copyFile(source: string, target: string): Promise<void> {
    await this.writeFile(target, await this.createReadable(source));
  }

  /**
   * Open a directory
   */
  async opendir(_filePath: string, _options?: unknown): Promise<Dir> {
    throw new Error('Not Implemented');
  }

  /**
   * Read a directory
   */
  async readdir(_filePath: string, _options?: unknown): Promise<string[]> {
    throw new Error('Not Implemented');
  }

  /**
   * List all files contained in a directory including the metadata such as size and last modified date.
   * The returned file.path is a relative path to the dirPath
   */
  async list(_dirPath: string, _options?: ListOptions): Promise<AsyncIterableIterator<ListedFile>> {
    throw new Error('Not Implemented');
  }

  /**
   * Recursively create a directory if the storage backend supports it, otherwise do nothing
   * @returns The first directory path created
   */
  async mkdir(_filePath: string, _options?: unknown): Promise<string | undefined> {
    throw new Error('Not Implemented');
  }

  /**
   * Rename or move a file or directory
   */
  async move(_source: string, _target: string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Remove a file or directory recursively
   */
  async remove(_filePath: string): Promise<void> {
    throw new Error('Not Implemented');
  }

  /**
   * Remove a directory if it is empty, otherwise do nothing. A missing directory is not an error.
   * The default checks then removes, so a backend that can do both atomically should override it.
   */
  async removeIfEmpty(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.readdir(dirPath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    if (entries.length === 0) {
      await this.remove(dirPath);
    }
  }
}

export { OcflStore };
