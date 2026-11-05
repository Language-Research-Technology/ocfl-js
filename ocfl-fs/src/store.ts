import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { type ListedFile, type ListOptions, OcflStore, type WriteFileData } from '@ocfl/ocfl';

export interface OcflFsStoreConfig {
  /** Custom fs module to use for any file operation */
  fs?: typeof fs | undefined;
}

/**
 * OCFL Object backed by local filesystem
 */
class OcflFsStore extends OcflStore {
  static instances: Map<object, OcflFsStore> = new Map();

  fs: typeof fs;

  /**
   * Create a new backend store that uses the given fs api.
   * A typical use case would be a locally mounted file system.
   */
  constructor(config?: OcflFsStoreConfig) {
    super();
    this.fs = config?.fs ?? fs;
  }

  async stat(filePath: string): Promise<fs.Stats> {
    return this.fs.promises.stat(filePath);
  }

  async createReadStream(filePath: string, options?: Parameters<typeof fs.createReadStream>[1]): Promise<fs.ReadStream> {
    return this.fs.createReadStream(filePath, options);
  }

  async createWriteStream(filePath: string, options?: Parameters<typeof fs.createWriteStream>[1]): Promise<fs.WriteStream> {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return this.fs.createWriteStream(filePath, options);
  }

  async createReadable(filePath: string, options?: Parameters<typeof fs.createReadStream>[1]): Promise<ReadableStream> {
    return Readable.toWeb(this.fs.createReadStream(filePath, options)) as ReadableStream;
  }

  async createWritable(filePath: string, options?: Parameters<typeof fs.createWriteStream>[1]): Promise<WritableStream> {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return Writable.toWeb(this.fs.createWriteStream(filePath, options));
  }

  async readFile(filePath: string, options: BufferEncoding | { encoding: BufferEncoding }): Promise<string>;
  async readFile(filePath: string, options?: unknown): Promise<Uint8Array>;
  async readFile(filePath: string, options?: unknown): Promise<string | Uint8Array> {
    return this.fs.promises.readFile(filePath, options as Parameters<typeof fs.promises.readFile>[1]);
  }

  async writeFile(filePath: string, data: WriteFileData, options?: object | string): Promise<void> {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const content = data instanceof ReadableStream ? Readable.fromWeb(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    await this.fs.promises.writeFile(filePath, content, options as Parameters<typeof fs.promises.writeFile>[2]);
  }

  async copyFile(source: string, target: string): Promise<void> {
    await this.fs.promises.mkdir(path.dirname(target), { recursive: true });
    await this.fs.promises.copyFile(source, target);
  }

  async opendir(filePath: string, options?: fs.OpenDirOptions): Promise<fs.Dir> {
    return this.fs.promises.opendir(filePath, options);
  }

  async readdir(filePath: string): Promise<string[]> {
    return this.fs.promises.readdir(filePath);
  }

  async list(dirPath: string, { encoding = 'utf8', bufferSize = 32, recursive = false }: ListOptions = {}): Promise<AsyncIterableIterator<ListedFile>> {
    const { opendir, stat } = this.fs.promises;
    const maxBuffer = bufferSize || 1;
    async function* generator(): AsyncGenerator<ListedFile> {
      const buffer: Promise<ListedFile>[] = [];
      const dirQueue = [opendir(dirPath, { encoding, bufferSize })];
      for (let dirp = dirQueue.shift(); dirp; dirp = dirQueue.shift()) {
        const dir = await dirp;
        for await (const de of dir) {
          const cdp = path.join(dir.path, de.name);
          if (recursive && de.isDirectory()) {
            dirQueue.push(opendir(cdp, { encoding, bufferSize }));
          } else {
            const f = stat(cdp).then((stats) => ({
              name: de.name,
              path: path.relative(dirPath, cdp),
              size: stats.size,
              lastModified: stats.mtime,
            }));
            buffer.push(f);
            if (buffer.length > maxBuffer) {
              // biome-ignore lint/style/noNonNullAssertion: an item was just pushed
              yield buffer.shift()!;
            }
          }
        }
      }
      yield* buffer;
    }
    return generator();
  }

  async mkdir(filePath: string, options: fs.MakeDirectoryOptions = { recursive: true }): Promise<string | undefined> {
    return this.fs.promises.mkdir(filePath, options);
  }

  async move(source: string, target: string): Promise<void> {
    const { cp, mkdir, mkdtemp, rename, rm } = this.fs.promises;
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
        throw error;
      }
    }
    // Stage on the target's filesystem so the final step is an atomic rename.
    const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}-`));
    try {
      const staged = path.join(staging, path.basename(target));
      await cp(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      await rename(staged, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await rm(source, { recursive: true, force: true });
  }

  async remove(filePath: string): Promise<void> {
    return this.fs.promises.rm(filePath, { recursive: true, force: true });
  }
}

export { OcflFsStore };
