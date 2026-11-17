import type fs from 'node:fs';
import nodePath from 'node:path';
import type { Readable } from 'node:stream';
import { ocflError } from './error.ts';
import { openRegularFile } from './file-system.ts';
import type { Version } from './ocfl-object.ts';
import { optionsObject } from './utils.ts';

/** Options for {@link OcflFile.stream}. */
interface StreamOptions {
  /** First byte to read, counting from 0. Defaults to 0. */
  readonly start?: number;
  /** Last byte to read, included as in an HTTP `Range` header. Defaults to the end of the file. */
  readonly end?: number;
}

/** A file in one version of an OCFL object. */
interface OcflFile {
  /** Logical path within the version, such as `audio/1.wav`. */
  readonly path: string;
  /** Lowercase hex digest of the content, in the object's {@link OcflObject.digestAlgorithm}. */
  readonly digest: string;
  /**
   * The version in which this logical path was created: the first of the versions up to this file's own that all have it, with
   * any content. A logical path removed and later added again is created again, and a rename creates the new logical path.
   */
  readonly createdIn: Version;
  /**
   * The version in which this logical path took its current content: the first of the versions up to this file's own that all
   * have it with this digest. Content changed and later changed back is modified again.
   */
  readonly modifiedIn: Version;
  /** When {@link OcflFile.createdIn} was committed. From the inventory, never from the stored file, whose times change when it is copied or restored. */
  readonly createdAt: Date;
  /** When {@link OcflFile.modifiedIn} was committed, such as for an HTTP `Last-Modified` header. From the inventory, never from the stored file. */
  readonly modifiedAt: Date;
  /**
   * Size in bytes.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the stored file is missing or isn't a regular file, such as a directory.
   * @throws The file system error, such as `EACCES` or `EIO`, if the stored file can't be read for any other reason.
   * @example
   * ```ts
   * reply.header('content-length', await file.size());
   * ```
   */
  size(): Promise<number>;
  /**
   * Opens the content, or a byte range of it, as a stream. It rejects before resolving if the content can't be read, so a server
   * can still answer with an error status. Consume or `destroy()` the stream: until then it holds the stored file open.
   *
   * Its chunks are `Buffer`s. With DOM typings, copy one into a `new Uint8Array` before giving it to a `Blob` or `Response`. For a
   * web stream, use `Readable.toWeb(await file.stream())`, and with DOM typings cast that to the global `ReadableStream`.
   *
   * @throws `TypeError` if `options` is given and isn't an object, or has a key other than `start` and `end`.
   * @throws `RangeError` if `start` or `end` isn't a whole number from 0, `start` is after `end`, or `start` is after the last
   * byte. An `end` after the last byte reads to the end.
   * @throws {@link OcflError} `INVALID_OBJECT` if the stored file is missing or isn't a regular file, such as a directory.
   * @throws The file system error, such as `EACCES` or `EIO`, if the stored file can't be read for any other reason.
   * @example
   * ```ts
   * // `start` and `end` from the request's `Range` header, checked against the size
   * const size = await file.size();
   * const body = await file.stream({ start, end });
   * reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).send(body);
   * ```
   */
  stream(options?: StreamOptions): Promise<Readable>;
  /**
   * Reads the content as UTF-8 text.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the stored file is missing or isn't a regular file, such as a directory.
   * @throws The file system error, such as `EACCES` or `EIO`, if the stored file can't be read for any other reason.
   * @example
   * ```ts
   * const metadata = JSON.parse(await file.text());
   * ```
   */
  text(): Promise<string>;
  /**
   * Reads the content into memory.
   *
   * @throws {@link OcflError} `INVALID_OBJECT` if the stored file is missing or isn't a regular file, such as a directory.
   * @throws The file system error, such as `EACCES` or `EIO`, if the stored file can't be read for any other reason.
   * @example
   * ```ts
   * const checksum = createHash('md5').update(await file.bytes()).digest('base64');
   * ```
   */
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

/** Finds the versions of an object in which a logical path of one of its versions was created and modified */
interface FileHistory {
  createdIn(path: string, version: number): Version;
  modifiedIn(path: string, digest: string, version: number): Version;
}

interface VersionFileOptions {
  readonly path: string;
  readonly digest: string;
  /** The number of the version the file is in */
  readonly version: number;
  readonly objectRoot: string;
  /** Where the content is stored, relative to `objectRoot` */
  readonly contentPath: string;
  readonly history: FileHistory;
}

class VersionFile implements OcflFile {
  readonly path: string;
  readonly digest: string;
  readonly #objectRoot: string;
  readonly #contentPath: string;
  readonly #version: number;
  readonly #history: FileHistory;

  constructor({ path, digest, version, objectRoot, contentPath, history }: VersionFileOptions) {
    this.path = path;
    this.digest = digest;
    this.#version = version;
    this.#objectRoot = objectRoot;
    this.#contentPath = contentPath;
    this.#history = history;
    Object.freeze(this);
  }

  get createdIn(): Version {
    return this.#history.createdIn(this.path, this.#version);
  }

  get modifiedIn(): Version {
    return this.#history.modifiedIn(this.path, this.digest, this.#version);
  }

  get createdAt(): Date {
    return this.createdIn.createdAt;
  }

  get modifiedAt(): Date {
    return this.modifiedIn.createdAt;
  }

  get #storedPath(): string {
    return nodePath.join(this.#objectRoot, this.#contentPath);
  }

  async size(): Promise<number> {
    const { handle, size } = await this.#open();
    await handle.close();
    return size;
  }

  async stream(options?: StreamOptions): Promise<Readable> {
    const { start, end } = streamOptions(options);
    const { handle, size } = await this.#open();
    if (start !== undefined && start >= size) {
      await handle.close();
      throw new RangeError(`A range can't start at byte ${start} of ${this.path}, which has ${size} bytes.`);
    }
    return handle.createReadStream({ start, end });
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
    const opened = await openRegularFile(this.#storedPath);
    if ('absent' in opened) {
      throw ocflError('INVALID_OBJECT', `The content of ${this.path}, ${this.#contentPath} in ${this.#objectRoot}, is ${opened.absent}.`, {
        cause: opened.cause,
      });
    }
    return opened;
  }
}

function streamOptions(options: unknown): StreamOptions {
  const checked: StreamOptions = optionsObject(options, 'file.stream', ['start', 'end'], '{ start: 0, end: 1023 }');
  for (const side of ['start', 'end'] as const) {
    const offset = checked[side];
    if (offset !== undefined && !(Number.isSafeInteger(offset) && offset >= 0)) {
      throw new RangeError(`A range's ${side} must be a whole number from 0, not ${offset}.`);
    }
  }
  if (checked.start !== undefined && checked.end !== undefined && checked.start > checked.end) {
    throw new RangeError(`A range can't start (${checked.start}) after it ends (${checked.end}).`);
  }
  return checked;
}

export { type FileHistory, type OcflFile, type StreamOptions, VersionFile };
