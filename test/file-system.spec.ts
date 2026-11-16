import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as fileSystem from '../src/file-system.ts';
import { failRename, fsError, mountSeparately } from './helpers/fs-failures.ts';

describe('fileSystem', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('removeIfEmpty', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-remove-if-empty-'));
    });
    afterEach(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it('removes an empty directory', async () => {
      await fileSystem.removeIfEmpty(dir);
      assert.equal(fs.existsSync(dir), false);
    });

    it('keeps a directory that has content', async () => {
      await fs.promises.writeFile(path.join(dir, 'a.txt'), 'a');
      await fileSystem.removeIfEmpty(dir);
      assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a');
    });

    it('ignores a missing directory', async () => {
      await assert.doesNotReject(fileSystem.removeIfEmpty(path.join(dir, 'missing')));
    });

    it('reports any other failure', async () => {
      mock.method(fs.promises, 'rmdir', async () => {
        throw fsError('EACCES');
      });
      await assert.rejects(fileSystem.removeIfEmpty(dir), { code: 'EACCES' });
    });
  });

  describe('removeQuietly', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-remove-quietly-'));
    });
    afterEach(async () => {
      mock.restoreAll();
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it('removes a directory and what it holds', async () => {
      await fs.promises.writeFile(path.join(dir, 'a.txt'), 'a');
      await fileSystem.removeQuietly(dir);
      assert.equal(fs.existsSync(dir), false);
    });

    it('resolves when the removal fails', async () => {
      mock.method(fs.promises, 'rm', async () => {
        throw fsError('EACCES');
      });
      await assert.doesNotReject(fileSystem.removeQuietly(dir));
    });
  });

  describe('move', () => {
    let dir: string;
    let source: string;
    let target: string;
    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-move-'));
      source = path.join(dir, 'src', 'v2');
      target = path.join(dir, 'obj', 'v2');
    });
    afterEach(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    async function writeFiles(root: string, files: Record<string, string>) {
      for (const [name, data] of Object.entries(files)) {
        await fs.promises.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.promises.writeFile(path.join(root, name), data);
      }
    }

    it('does not copy across filesystems, leaving the source and target as they were', async () => {
      await writeFiles(source, { 'new.txt': 'new' });
      mountSeparately(path.join(dir, 'src'));

      await assert.rejects(fileSystem.move(source, target), { code: 'EXDEV' });

      assert.deepEqual(await fs.promises.readdir(source), ['new.txt']);
      assert.equal(fs.existsSync(target), false);
    });

    it('rethrows rename errors other than EXDEV and leaves the source in place', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });
      failRename('EACCES');

      await assert.rejects(fileSystem.move(source, target), { code: 'EACCES' });

      assert.equal(await fs.promises.readFile(path.join(source, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(target), false);
    });

    it('moves a directory with rename on the same filesystem', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });

      await fileSystem.move(source, target);

      assert.equal(await fs.promises.readFile(path.join(target, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(source), false);
    });
  });

  describe('relativeWithin', () => {
    it('gives a path inside the root relative to it, and the root itself as empty', () => {
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', 'a/b'), 'a/b');
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '/srv/ocfl/a/../b'), 'b');
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '.'), '');
    });

    it('gives nothing for a path outside the root', () => {
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '..'), undefined);
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '../ocfl-other/a'), undefined);
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '/srv'), undefined);
    });

    it('keeps a name inside the root that only starts with two dots', () => {
      assert.strictEqual(fileSystem.relativeWithin('/srv/ocfl', '..a'), '..a');
    });
  });
});
