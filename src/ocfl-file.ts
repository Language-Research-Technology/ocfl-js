import fs from 'node:fs';
import nodePath from 'node:path';
import * as store from './store.ts';

/** Part of a file's content. Both ends are byte offsets from 0, and `end` is included, as in an HTTP `Range` header. */
interface ByteRange {
  /** First byte to read. Defaults to 0. */
  readonly start?: number;
  /** Last byte to read. Defaults to the end of the file. */
  readonly end?: number;
}

/** A file in one version of an OCFL object. */
interface OcflFile {
  /** Logical path within the version, such as `audio/1.wav`. */
  readonly path: string;
  /** Hex digest of the content, in the object's {@link OcflObject.digestAlgorithm}. */
  readonly digest: string;
  /** Size in bytes. */
  size(): Promise<number>;
  /**
   * Streams the content, or a byte range of it. A missing or unreadable stored file surfaces as an error while reading.
   *
   * @throws `RangeError` if an end of the range isn't a whole number from 0, or `start` is after `end`.
   */
  stream(range?: ByteRange): ReadableStream<Uint8Array>;
  /** Reads the content as UTF-8 text. */
  text(): Promise<string>;
  /** Reads the content into memory. */
  bytes(): Promise<Uint8Array>;
}

class StoredFile implements OcflFile {
  readonly path: string;
  readonly digest: string;
  readonly #objectRoot: string;
  readonly #contentPath: string;

  /** @param contentPath - Where the content is stored, relative to `objectRoot` */
  constructor(path: string, digest: string, objectRoot: string, contentPath: string) {
    this.path = path;
    this.digest = digest;
    this.#objectRoot = objectRoot;
    this.#contentPath = contentPath;
    Object.freeze(this);
  }

  get #storedPath(): string {
    return nodePath.join(this.#objectRoot, this.#contentPath);
  }

  async size(): Promise<number> {
    return (await fs.promises.stat(this.#storedPath)).size;
  }

  stream(range?: ByteRange): ReadableStream<Uint8Array> {
    return store.createReadable(this.#storedPath, { start: range?.start, end: range?.end });
  }

  async text(): Promise<string> {
    return fs.promises.readFile(this.#storedPath, 'utf8');
  }

  async bytes(): Promise<Uint8Array> {
    return fs.promises.readFile(this.#storedPath);
  }
}

export { type ByteRange, type OcflFile, StoredFile };
