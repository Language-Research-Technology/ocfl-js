import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OcflFsStore } from '../src/store.ts';

function fsWithRenameError(code: string, fails: (from: string, to: string) => boolean = () => true): typeof fs {
  const rename = async (from: fs.PathLike, to: fs.PathLike) => {
    if (fails(String(from), String(to))) {
      throw Object.assign(new Error('rename failed'), { code });
    }
    return fs.promises.rename(from, to);
  };
  return { ...fs, promises: { ...fs.promises, rename } };
}

describe('OcflFsStore', () => {
  var store = new OcflFsStore();
  // before(function () {
  //   store = new OcflFsStore();
  // });

  it('exists', async () => {
    assert.equal(await store.exists(import.meta.dirname), true);
    assert.equal(await store.exists(path.join(import.meta.dirname, 'object.spec.ts')), true);
    assert.equal(await store.exists('a'), false);
  });

  it('createDir', async () => {
    var p1 = await store.mkdir(path.join(import.meta.dirname, 'a/b/c'));
    assert.equal(p1, path.join(import.meta.dirname, 'a'));
    var p2 = await store.mkdir(path.join(import.meta.dirname, 'a/b/c/d/e'));
    assert.equal(p2, path.join(import.meta.dirname, 'a/b/c/d'));
    await fs.promises.rm(p1!, { recursive: true, force: true });
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
      const denied = { ...fs, promises: { ...fs.promises, rmdir: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) } };
      await assert.rejects(new OcflFsStore({ fs: denied as typeof fs }).removeIfEmpty(dir), { code: 'EACCES' });
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

    function crossDeviceFs() {
      const otherDevice = path.join(dir, 'src');
      const onOtherDevice = (p: string) => p === otherDevice || p.startsWith(otherDevice + path.sep);
      return fsWithRenameError('EXDEV', (from, to) => onOtherDevice(from) !== onOtherDevice(to));
    }

    async function writeFiles(root: string, files: Record<string, string>) {
      for (const [name, data] of Object.entries(files)) {
        await fs.promises.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.promises.writeFile(path.join(root, name), data);
      }
    }

    it('moves a directory across filesystems when rename fails with EXDEV', async () => {
      await writeFiles(source, { 'content/a.txt': 'hello', 'inventory.json': '{}' });

      await new OcflFsStore({ fs: crossDeviceFs() }).move(source, target);

      assert.equal(await fs.promises.readFile(path.join(target, 'content', 'a.txt'), 'utf8'), 'hello');
      assert.equal(await fs.promises.readFile(path.join(target, 'inventory.json'), 'utf8'), '{}');
      assert.deepEqual(await fs.promises.readdir(path.dirname(target)), ['v2']);
      assert.equal(fs.existsSync(source), false);
    });

    it('keeps relative symlinks working when moving across filesystems', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });
      await fs.promises.symlink('a.txt', path.join(source, 'link'));

      await new OcflFsStore({ fs: crossDeviceFs() }).move(source, target);

      assert.equal(await fs.promises.readlink(path.join(target, 'link')), 'a.txt');
      assert.equal(await fs.promises.readFile(path.join(target, 'link'), 'utf8'), 'hello');
    });

    it('moves a file across filesystems when rename fails with EXDEV, keeping its timestamps', async () => {
      const mtime = new Date('2020-01-02T03:04:05Z');
      await writeFiles(source, { 'a.txt': 'hello' });
      await fs.promises.utimes(path.join(source, 'a.txt'), mtime, mtime);

      await new OcflFsStore({ fs: crossDeviceFs() }).move(path.join(source, 'a.txt'), path.join(target, 'b.txt'));

      assert.equal(await fs.promises.readFile(path.join(target, 'b.txt'), 'utf8'), 'hello');
      assert.equal((await fs.promises.stat(path.join(target, 'b.txt'))).mtime.getTime(), mtime.getTime());
      assert.equal(fs.existsSync(path.join(source, 'a.txt')), false);
    });

    it('rethrows rename errors other than EXDEV and leaves the source in place', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });

      await assert.rejects(new OcflFsStore({ fs: fsWithRenameError('EACCES') }).move(source, target), { code: 'EACCES' });

      assert.equal(await fs.promises.readFile(path.join(source, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(target), false);
    });

    it('leaves no partial target when the cross-filesystem copy fails', async () => {
      await writeFiles(source, { 'a.txt': 'hello', 'b.txt': 'world' });
      const base = crossDeviceFs();
      const cp = async (_from: string | URL, to: string | URL) => {
        await writeFiles(String(to), { 'a.txt': 'hello' });
        throw Object.assign(new Error('copy failed'), { code: 'EIO' });
      };
      const store = new OcflFsStore({ fs: { ...base, promises: { ...base.promises, cp } } });

      await assert.rejects(store.move(source, target), { code: 'EIO' });

      assert.deepEqual(await fs.promises.readdir(path.dirname(target)), []);
      assert.deepEqual((await fs.promises.readdir(source)).sort(), ['a.txt', 'b.txt']);
    });

    it('completes a cross-filesystem move when the source cannot be removed', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });
      const base = crossDeviceFs();
      const rm = async (target_: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target_) === source) {
          throw Object.assign(new Error('rm failed'), { code: 'EBUSY' });
        }
        return fs.promises.rm(target_, options);
      };
      const store = new OcflFsStore({ fs: { ...base, promises: { ...base.promises, rm } } });

      await store.move(source, target);

      assert.equal(await fs.promises.readFile(path.join(target, 'a.txt'), 'utf8'), 'hello');
    });

    it('rejects a cross-filesystem move onto a non-empty directory instead of merging', async () => {
      await writeFiles(source, { 'new.txt': 'new' });
      await writeFiles(target, { 'old.txt': 'old' });

      await assert.rejects(new OcflFsStore({ fs: crossDeviceFs() }).move(source, target), {
        code: /^(ENOTEMPTY|EEXIST)$/,
      });

      assert.deepEqual(await fs.promises.readdir(target), ['old.txt']);
      assert.deepEqual(await fs.promises.readdir(path.dirname(target)), ['v2']);
      assert.deepEqual(await fs.promises.readdir(source), ['new.txt']);
    });

    it('replaces an existing file when moving a file across filesystems', async () => {
      await writeFiles(source, { 'inventory.json.tmp': 'new' });
      await writeFiles(target, { 'inventory.json': 'old' });

      await new OcflFsStore({ fs: crossDeviceFs() }).move(path.join(source, 'inventory.json.tmp'), path.join(target, 'inventory.json'));

      assert.equal(await fs.promises.readFile(path.join(target, 'inventory.json'), 'utf8'), 'new');
      assert.deepEqual(await fs.promises.readdir(target), ['inventory.json']);
      assert.deepEqual(await fs.promises.readdir(source), []);
    });

    it('moves a directory with rename on the same filesystem', async () => {
      await writeFiles(source, { 'a.txt': 'hello' });

      await new OcflFsStore().move(source, target);

      assert.equal(await fs.promises.readFile(path.join(target, 'a.txt'), 'utf8'), 'hello');
      assert.equal(fs.existsSync(source), false);
    });
  });
});
