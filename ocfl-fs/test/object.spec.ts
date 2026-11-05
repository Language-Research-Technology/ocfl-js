import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Inventory } from '@ocfl/ocfl';
import ocflTests from '@ocfl/ocfl-tests';
import ocfl, { ObjectNotFoundError, ObjectNotLoadedError } from '../src/index.ts';
import { ocflError } from './ocfl-error.ts';

describe('OcflObject class using OcflFsStore', () => {
  // it("constructor", function() {
  //   console.log(this.ocfl);
  //   assert.strictEqual(DIGEST.size(), 2);
  //   assert.strictEqual(DIGEST_FIXITY.size(), 5);
  // });

  ocflTests.object(ocfl);
});

describe('OcflObject with a malformed or missing inventory', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-object-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  /** Create a one-file object, then rewrite its inventory (and sidecar) with `corrupt` */
  async function malformedObject(name: string, corrupt: (inv: Partial<Inventory>) => void) {
    const root = path.join(tempdir, name);
    await ocfl.object({ id: name, root }).update(async (t) => t.write('a.txt', 'a'));
    const inv = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8'));
    corrupt(inv);
    const data = JSON.stringify(inv, null, 2);
    await fs.promises.writeFile(path.join(root, 'inventory.json'), data);
    await fs.promises.writeFile(path.join(root, 'inventory.json.sha512'), `${createHash('sha512').update(data).digest('hex')} inventory.json\n`);
    return ocfl.object({ root });
  }

  it('rejects an update when the inventory head is not in versions', async () => {
    const o = await malformedObject('bad-head', (inv) => {
      inv.head = 'v2';
    });
    await assert.rejects(
      o.update(async (t) => t.write('b.txt', 'b')),
      { name: 'ValidationError', code: 'E040', detail: 'head "v2" is not in versions' },
    );
  });

  it('rejects loading an inventory whose head is not in versions', async () => {
    const o = await malformedObject('bad-head-load', (inv) => {
      inv.head = 'v2';
    });
    await assert.rejects(o.load(), { name: 'ValidationError', code: 'E040', detail: 'head "v2" is not in versions' });
  });

  it('rejects loading an inventory with an empty head', async () => {
    const o = await malformedObject('empty-head', (inv) => {
      inv.head = '';
    });
    await assert.rejects(o.load(), { name: 'ValidationError', code: 'E040', detail: 'empty head' });
  });

  it('rejects loading an inventory without a head', async () => {
    const o = await malformedObject('no-head', (inv) => {
      delete inv.head;
    });
    await assert.rejects(o.load(), { name: 'ValidationError', code: 'E036', detail: 'missing head' });
  });

  it('rejects loading an inventory with a state digest that is not in the manifest', async () => {
    let digest: string | undefined;
    const o = await malformedObject('bad-manifest', (inv) => {
      [digest] = Object.keys(inv.manifest!);
      inv.manifest = {};
    });
    await assert.rejects(o.load(), { name: 'ValidationError', code: 'E050', detail: `digest "${digest}" is not in the manifest` });
  });

  it('finds no file in a version that does not exist', async () => {
    const root = path.join(tempdir, 'missing-version');
    const o = ocfl.object({ id: 'missing-version', root });
    await o.update(async (t) => t.write('a.txt', 'a'));
    const { digest } = (await o.fileByLogicalPath('a.txt'))!;
    assert.strictEqual(await o.fileByDigest(digest!, 'v9'), undefined);
    assert.strictEqual(await o.fileByLogicalPath('a.txt', 'v9'), undefined);
    assert.strictEqual(await o.count('v9'), 0);
  });

  it('rejects a digestAlgorithm that is not lowercase', () => {
    // @ts-expect-error deliberately invalid
    assert.throws(() => ocfl.object({ id: 'upper-digest', root: path.join(tempdir, 'upper-digest'), digestAlgorithm: 'SHA256' }), {
      message: 'Invalid digest algorithm. Must be one of `sha256` or `sha512`.',
    });
  });

  it('rejects an unsupported digestAlgorithm', () => {
    // @ts-expect-error deliberately invalid
    assert.throws(() => ocfl.object({ id: 'md5-digest', root: path.join(tempdir, 'md5-digest'), digestAlgorithm: 'md5' }), {
      message: 'Invalid digest algorithm. Must be one of `sha256` or `sha512`.',
    });
  });

  it('replaces the previous version content when updating in REPLACE mode', async () => {
    const o = ocfl.object({ id: 'replace-mode', root: path.join(tempdir, 'replace-mode') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await o.update(async (t) => t.write('b.txt', 'b'), 'REPLACE');
    const paths = Array.from(await o.files(), (f) => f.logicalPath);
    assert.deepStrictEqual(paths, ['b.txt']);
  });

  it('keeps the previous version content when updating in the default MERGE mode', async () => {
    const o = ocfl.object({ id: 'merge-mode', root: path.join(tempdir, 'merge-mode') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await o.update(async (t) => t.write('b.txt', 'b'));
    const paths = Array.from(await o.files(), (f) => f.logicalPath).sort();
    assert.deepStrictEqual(paths, ['a.txt', 'b.txt']);
  });

  it('rejects an unknown update mode', async () => {
    const o = ocfl.object({ id: 'bad-mode', root: path.join(tempdir, 'bad-mode') });
    await assert.rejects(
      // @ts-expect-error deliberately invalid
      o.update(async (t) => t.write('a.txt', 'a'), 'APPEND'),
      { name: 'TypeError', message: "Invalid mode 'APPEND'" },
    );
    await assert.rejects(
      // @ts-expect-error deliberately invalid
      o.update(async (t) => t.write('a.txt', 'a'), 'replace'),
      { name: 'TypeError', message: "Invalid mode 'replace'" },
    );
  });

  it('exports the object errors for instanceof checks', async () => {
    const o = ocfl.object({ id: 'exported-errors', root: path.join(tempdir, 'exported-errors') });
    assert.throws(() => o.getFile('a.txt'), ObjectNotLoadedError);
    await o.load();
    assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
  });

  it('rejects counting or listing files of an object without an inventory', async () => {
    const o = ocfl.object({ id: 'no-inventory', root: path.join(tempdir, 'no-inventory') });
    await assert.rejects(o.count(), ocflError('OBJECT_NOT_FOUND'));
    await assert.rejects(o.files(), ocflError('OBJECT_NOT_FOUND'));
  });

  it('rejects an update while another update of the same object is uncommitted', async () => {
    const o = ocfl.object({ id: 'concurrent', root: path.join(tempdir, 'concurrent') });
    await o.update(async (t) => {
      await t.write('a.txt', 'a');
      await assert.rejects(
        o.update(async (t2) => t2.write('b.txt', 'b')),
        ocflError('UPDATE_IN_PROGRESS'),
      );
    });
  });

  it('rejects creating an object in a non-empty directory', async () => {
    const root = path.join(tempdir, 'not-empty');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, 'stray.txt'), 'x');
    await assert.rejects(
      ocfl.object({ id: 'not-empty', root }).update(async (t) => t.write('a.txt', 'a')),
      ocflError('DIRECTORY_NOT_EMPTY'),
    );
  });

  it('rejects a logical path that is absolute or leaves the object', async () => {
    const o = ocfl.object({ id: 'bad-path', root: path.join(tempdir, 'bad-path') });
    await assert.rejects(
      o.update(async (t) => t.write('../escape.txt', 'x')),
      ocflError('INVALID_LOGICAL_PATH'),
    );
    await assert.rejects(
      o.update(async (t) => t.write('/abs.txt', 'x')),
      ocflError('INVALID_LOGICAL_PATH'),
    );
    await assert.rejects(
      o.update(async (t) => t.write('..\\escape.txt', 'x')),
      ocflError('INVALID_LOGICAL_PATH'),
    );
    await o.update(async (t) => t.write('a.txt', 'a'));
    await assert.rejects(
      o.update(async (t) => t.copy('a.txt', '../escape.txt')),
      ocflError('INVALID_LOGICAL_PATH'),
    );
    const dir = path.join(tempdir, 'bad-path-dir');
    await fs.promises.mkdir(dir);
    await fs.promises.writeFile(path.join(dir, 'b.txt'), 'b');
    await assert.rejects(
      o.update(async (t) => t.import(dir, 'a/../b')),
      ocflError('INVALID_LOGICAL_PATH'),
    );
  });

  it('accepts a logical path whose name starts with two dots', async () => {
    const o = ocfl.object({ id: 'dot-name', root: path.join(tempdir, 'dot-name') });
    await o.update(async (t) => t.write('..notes.txt', 'x'));
    assert.strictEqual(await o.getFile('..notes.txt')?.text(), 'x');
  });

  it('rejects reading a lazy file the object does not contain', async () => {
    const root = path.join(tempdir, 'lazy-missing');
    await ocfl.object({ id: 'lazy-missing', root }).update(async (t) => t.write('a.txt', 'a'));
    const file = ocfl.object({ root }).getFile('missing.txt', undefined, true);
    await assert.rejects(file!.text(), ocflError('FILE_NOT_FOUND'));
  });

  it('rejects copying from a logical path the object does not contain', async () => {
    const o = ocfl.object({ id: 'copy-missing', root: path.join(tempdir, 'copy-missing') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await assert.rejects(
      o.update(async (t) => t.copy('missing.txt', 'b.txt')),
      ocflError('FILE_NOT_FOUND'),
    );
  });

  it('rejects renaming a logical path the object does not contain', async () => {
    const o = ocfl.object({ id: 'rename-missing', root: path.join(tempdir, 'rename-missing') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await assert.rejects(
      o.update(async (t) => t.rename('missing.txt', 'b.txt')),
      ocflError('FILE_NOT_FOUND'),
    );
  });

  it('keeps the error of each source an import fails on', async () => {
    const source = path.join(tempdir, 'import-source.txt');
    await fs.promises.writeFile(source, 'x');
    const o = ocfl.object({ id: 'import-fail', root: path.join(tempdir, 'import-fail') });
    await assert.rejects(o.import([[source, '../escape.txt']]), (e) => {
      assert.ok(e instanceof AggregateError);
      assert.strictEqual(e.errors.length, 1);
      return ocflError('INVALID_LOGICAL_PATH')(e.errors[0]);
    });
  });

  it('rolls back and rethrows the update error when an earlier operation failed', async () => {
    const o = ocfl.object({ id: 'rollback', root: path.join(tempdir, 'rollback') });
    await assert.rejects(
      o.update(async (t) => {
        await t.write('a.txt', 'a');
        await t.write('../escape.txt', 'x').catch(() => {});
        throw new Error('callback failed');
      }),
      { message: 'callback failed' },
    );
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(await o.count(), 1);
  });

  it('fails a directory import when one of its files fails', async () => {
    const dir = path.join(tempdir, 'import-dir');
    await fs.promises.mkdir(dir);
    await fs.promises.writeFile(path.join(dir, 'ok.txt'), 'ok');
    await fs.promises.writeFile(path.join(dir, 'locked.txt'), 'locked');
    await fs.promises.chmod(path.join(dir, 'locked.txt'), 0o000);
    const o = ocfl.object({ id: 'import-dir', root: path.join(tempdir, 'import-dir-object') });
    try {
      await assert.rejects(o.import(dir));
      await assert.rejects(o.count(), ocflError('OBJECT_NOT_FOUND'));
    } finally {
      await fs.promises.chmod(path.join(dir, 'locked.txt'), 0o600);
    }
  });

  it('rolls back an update that leaves a writable stream open', async () => {
    const o = ocfl.object({ id: 'open-writer', root: path.join(tempdir, 'open-writer') });
    await assert.rejects(
      o.update(async (t) => {
        await t.createWritable('a.txt');
      }),
      /Unfinished operations detected/,
    );
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(await o.count(), 1);
  });
});
