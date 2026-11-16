import fs from 'node:fs';
import nodePath from 'node:path';
import type { Readable } from 'node:stream';
import { ocflError } from './error.ts';

/** Part of a file's content. Both ends are byte offsets from 0, and `end` is included, as in an HTTP `Range` header. */
interface ByteRange {
  /** First byte to read. Defaults to 0. */
  readonly start?: number;
  /** Last byte to read. Defaults to the end of the file. */
  readonly end?: number;
}

/**
 * A file in one version of an OCFL object.
 *
 * Each method rejects with {@link OcflError} `INVALID_OBJECT` if the stored file isn't a regular file, such as a directory,
 * and with the file system error, such as `ENOENT` or `EACCES`, if it is missing or can't be read.
 */
interface OcflFile {
  /** Logical path within the version, such as `audio/1.wav`. */
  readonly path: string;
  /** Lowercase hex digest of the content, in the object's {@link OcflObject.digestAlgorithm}. */
  readonly digest: string;
  /** Size in bytes. */
  size(): Promise<number>;
  /**
   * Opens the content, or a byte range of it, as a stream. It rejects before resolving if the content can't be read, so a server
   * can still answer with an error status. Consume or `destroy()` the stream: until then it holds the stored file open.
   *
   * Its chunks are `Buffer`s. With DOM typings, copy one into a `new Uint8Array` before giving it to a `Blob` or `Response`. For a
   * web stream, use `Readable.toWeb(await file.stream())`, and with DOM typings cast that to the global `ReadableStream`.
   *
   * @throws `RangeError` if an end of the range isn't a whole number from 0, `start` is after `end`, or `start` is after the last
   * byte. An `end` after the last byte reads to the end.
   * @throws {@link OcflError} `INVALID_OBJECT` if the stored file isn't a regular file.
   */
  stream(range?: ByteRange): Promise<Readable>;
  /** Reads the content as UTF-8 text. */
  text(): Promise<string>;
  /** Reads the content into memory. */
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
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
    const stats = await fs.promises.stat(this.#storedPath);
    this.#assertRegularFile(stats);
    return stats.size;
  }

  async stream(range?: ByteRange): Promise<Readable> {
    checkRange(range);
    const { handle, size } = await this.#open();
    if (range?.start !== undefined && range.start >= size) {
      await handle.close();
      throw new RangeError(`A range can't start at byte ${range.start} of ${this.path}, which has ${size} bytes.`);
    }
    return handle.createReadStream({ start: range?.start, end: range?.end });
  }

  async text(): Promise<string> {
    return this.#read((handle) => handle.readFile('utf8'));
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.#read((handle) => handle.readFile());
  }

  async #read<T>(read: (handle: fs.promises.FileHandle) => Promise<T>): Promise<T> {
    const { handle } = await this.#open();
    try {
      return await read(handle);
    } finally {
      await handle.close();
    }
  }

  async #open(): Promise<{ handle: fs.promises.FileHandle; size: number }> {
    const handle = await fs.promises.open(this.#storedPath, 'r');
    try {
      const stats = await handle.stat();
      this.#assertRegularFile(stats);
      return { handle, size: stats.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  #assertRegularFile(stats: fs.Stats): void {
    if (!stats.isFile()) {
      throw ocflError('INVALID_OBJECT', `The content of ${this.path}, ${this.#contentPath} in ${this.#objectRoot}, is not a file.`);
    }
  }
}

function checkRange(range: ByteRange | undefined): void {
  for (const side of ['start', 'end'] as const) {
    const offset = range?.[side];
    if (offset !== undefined && !(Number.isSafeInteger(offset) && offset >= 0)) {
      throw new RangeError(`A range's ${side} must be a whole number from 0, not ${offset}.`);
    }
  }
  if (range?.start !== undefined && range.end !== undefined && range.start > range.end) {
    throw new RangeError(`A range can't start (${range.start}) after it ends (${range.end}).`);
  }
}

export { type ByteRange, type OcflFile, StoredFile };
