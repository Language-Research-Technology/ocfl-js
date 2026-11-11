import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as store from '../src/store.ts';
import { failRename, fsError, mountSeparately } from './helpers/fs-failures.ts';

describe('store', () => {
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
      await store.removeIfEmpty(dir);
      assert.equal(fs.existsSync(dir), false);
    });

    it('keeps a directory that has content', async () => {
      await fs.promises.writeFile(path.join(dir, 'a.txt'), 'a');
      await store.removeIfEmpty(dir);
      assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a');
    });

    it('ignores a missing directory', async () => {
      await assert.doesNotReject(store.removeIfEmpty(path.join(dir, 'missing')));
    });

    it('reports any other failure', async () => {
      mock.method(fs.promises, 'rmdir', async () => {
        throw fsError('EACCES');
      });
      await assert.rejects(store.removeIfEmpty(dir), { code: 'EACCES' });
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

      await assert.rejects(store.move(source, target), { code: 'EXDEV' });

      assert.deepEqual(await fs.promises.readdir(source), ['new.txt']);
      assert.equal(fs.existsSync(target), false);
    });

    it('rethrows rename errors other than EXDEV and leaves the source in place', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });
      failRename('EACCES');

      await assert.rejects(store.move(source, target), { code: 'EACCES' });

      assert.equal(await fs.promises.readFile(path.join(source, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(target), false);
    });

    it('moves a directory with rename on the same filesystem', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });

      await store.move(source, target);

      assert.equal(await fs.promises.readFile(path.join(target, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(source), false);
    });
  });
});
