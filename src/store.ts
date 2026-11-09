import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { type BinaryOptions, type EncodingOptions, type ListedFile, type ListOptions, OcflStore, type WriteFileData } from './backend-store.ts';

function hasErrorCode(error: unknown, ...codes: string[]) {
  return error instanceof Error && 'code' in error && codes.includes(error.code as string);
}

/**
 * OCFL Object backed by local filesystem
 */
class OcflFsStore extends OcflStore {
  async stat(filePath: string) {
    return fs.promises.stat(filePath);
  }

  async createReadable(filePath: string, options?: Parameters<typeof fs.createReadStream>[1]) {
    return Readable.toWeb(fs.createReadStream(filePath, options)) as ReadableStream;
  }

  async createWritable(filePath: string, options?: Parameters<typeof fs.createWriteStream>[1]) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return Writable.toWeb(fs.createWriteStream(filePath, options));
  }

  async readFile(filePath: string, options: EncodingOptions): Promise<string>;
  async readFile(filePath: string, options?: BinaryOptions): Promise<Uint8Array>;
  async readFile(filePath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array>;
  async readFile(filePath: string, options?: EncodingOptions | BinaryOptions): Promise<string | Uint8Array> {
    return fs.promises.readFile(filePath, options);
  }

  async writeFile(filePath: string, data: WriteFileData, options?: object | string) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Readable.from, not fromWeb: fromWeb reads eagerly, so a source failure before writeFile attaches would be uncaught
    const content = data instanceof ReadableStream ? Readable.from(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    await fs.promises.writeFile(filePath, content, options as Parameters<typeof fs.promises.writeFile>[2]);
  }

  async copyFile(source: string, target: string) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(source, target);
  }

  async opendir(filePath: string, options?: fs.OpenDirOptions) {
    return fs.promises.opendir(filePath, options);
  }

  async readdir(filePath: string) {
    return fs.promises.readdir(filePath);
  }

  async list(dirPath: string, { encoding = 'utf8', bufferSize = 32, recursive = false }: ListOptions = {}) {
    const { opendir, stat } = fs.promises;
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

  async mkdir(filePath: string, options: fs.MakeDirectoryOptions = { recursive: true }) {
    return fs.promises.mkdir(filePath, options);
  }

  async move(source: string, target: string) {
    const { cp, mkdir, mkdtemp, rename, rm } = fs.promises;
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'EXDEV')) {
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
    // The target is complete, so a leftover source must not fail the move
    await rm(source, { recursive: true, force: true }).catch(() => {});
  }

  async remove(filePath: string) {
    return fs.promises.rm(filePath, { recursive: true, force: true });
  }

  async removeIfEmpty(dirPath: string) {
    try {
      await fs.promises.rmdir(dirPath);
    } catch (error) {
      // POSIX allows EEXIST in place of ENOTEMPTY
      if (!hasErrorCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST')) {
        throw error;
      }
    }
  }
}

export { OcflFsStore };
