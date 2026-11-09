import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Inventory, OcflVersion } from '@ocfl/ocfl';
import ocflTests from '@ocfl/ocfl-tests';
import ocfl, { ObjectNotFoundError, ObjectNotLoadedError } from '../src/index.ts';
import { ocflError } from './ocfl-error.ts';

async function writeInventory(inventoryPath: string, data: string) {
  await fs.promises.writeFile(inventoryPath, data);
  await fs.promises.writeFile(`${inventoryPath}.sha512`, `${createHash('sha512').update(data).digest('hex')} inventory.json\n`);
}

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
    await writeInventory(path.join(root, 'inventory.json'), JSON.stringify(inv, null, 2));
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

  for (const op of ['copy', 'rename', 'move'] as const) {
    describe(`${op}() onto an occupied target`, () => {
      const files = { 'a.txt': 'a', 'b.txt': 'b', 'same.txt': 'a', 'dir/c.txt': 'c', 'other/d.txt': 'd' };
      const cases = [
        ['an existing file with different content', 'a.txt', 'b.txt'],
        ['an existing file with identical content', 'a.txt', 'same.txt'],
        ['the same path as source and target', 'a.txt', 'a.txt'],
        ['a directory with content', 'a.txt', 'other'],
        ['a target inside an existing file', 'a.txt', 'b.txt/x/y.txt'],
        ['a dot-prefixed form of an existing file', 'a.txt', './b.txt'],
        ['a directory source onto a directory with non-overlapping content', 'dir', 'other'],
      ] as const;

      cases.forEach(([name, source, target], index) => {
        it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
          const o = ocfl.object({ id: `${op}-${index}`, root: path.join(tempdir, `${op}-occupied-${index}`) });
          await o.update(async (t) => {
            for (const [logicalPath, content] of Object.entries(files)) {
              await t.write(logicalPath, content);
            }
            await assert.rejects(t[op](source, target), ocflError('FILE_EXISTS'));
          });
          const paths = Array.from(await o.files(), (f) => f.logicalPath).sort();
          assert.deepStrictEqual(paths, Object.keys(files).sort());
          for (const [logicalPath, content] of Object.entries(files)) {
            assert.strictEqual(await o.getFile(logicalPath)?.text(), content);
          }
        });
      });

      it('throws FILE_NOT_FOUND for a missing source, even onto an existing file', async () => {
        const o = ocfl.object({ id: `${op}-missing`, root: path.join(tempdir, `${op}-occupied-missing`) });
        await o.update(async (t) => t.write('a.txt', 'a'));
        await assert.rejects(
          o.update(async (t) => t[op]('missing.txt', 'a.txt')),
          ocflError('FILE_NOT_FOUND'),
        );
      });

      it('replaces a target removed first in the same transaction, keeping the earlier version', async () => {
        const o = ocfl.object({ id: `${op}-removed`, root: path.join(tempdir, `${op}-occupied-removed`) });
        await o.update(async (t) => {
          await t.write('a.txt', 'a');
          await t.write('b.txt', 'b');
        });
        await o.update(async (t) => {
          await t.remove('b.txt');
          await t[op]('a.txt', 'b.txt');
        });
        assert.strictEqual(await o.getFile('b.txt')?.text(), 'a');
        assert.strictEqual(await o.getFile('b.txt', 'v1')?.text(), 'b');
      });
    });
  }

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

describe('OcflObject.ocflVersion', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-object-version-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  async function existingObject(name: string, ocflVersion: OcflVersion) {
    const root = path.join(tempdir, name);
    await ocfl.object({ id: name, root, ocflVersion }).update(async (t) => t.write('a.txt', 'a'));
    return root;
  }

  it('reports the version of a 1.0 object when none is configured', async () => {
    const o = ocfl.object({ root: await existingObject('unconfigured', '1.0') });
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('reports the version of a 1.0 object in a 1.1 storage root', async () => {
    const root = path.join(tempdir, 'mixed-root');
    const created = ocfl.storage({ root, ocflVersion: '1.0', layout: 'HashedNTupleStorageLayout' });
    await created.create();
    await created.object('a').update(async (t) => t.write('a.txt', 'a'));
    await fs.promises.rm(path.join(root, '0=ocfl_1.0'));
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');

    const o = (await ocfl.storage({ root }).load()).object('a');
    assert.strictEqual(o.ocflVersion, '1.1');
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('ignores a configured version that differs from the object', async () => {
    const o = ocfl.object({ root: await existingObject('configured-earlier', '1.1'), ocflVersion: '1.0' });
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.1');
  });

  it('is correct after refresh on an object that has not been loaded', async () => {
    const o = ocfl.object({ root: await existingObject('refresh', '1.0') });
    await o.refresh();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('is correct after update on an object that has not been loaded', async () => {
    const o = ocfl.object({ root: await existingObject('update', '1.0') });
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('is not changed by reading an earlier version with an older inventory', async () => {
    const root = await existingObject('earlier-inventory', '1.1');
    const o = ocfl.object({ root });
    await o.update(async (t) => t.write('b.txt', 'b'));
    const earlier = path.join(root, 'v1', 'inventory.json');
    const data = (await fs.promises.readFile(earlier, 'utf8')).replace('https://ocfl.io/1.1/spec/#inventory', 'https://ocfl.io/1.0/spec/#inventory');
    await writeInventory(earlier, data);

    const reader = ocfl.object({ root });
    await reader.load();
    assert.strictEqual(reader.ocflVersion, '1.1');
    assert.strictEqual((await reader.getInventory('v1'))?.type, 'https://ocfl.io/1.0/spec/#inventory');
    assert.strictEqual(reader.ocflVersion, '1.1');
  });

  it('returns the configured version or the default before loading', async () => {
    const configured = await existingObject('before-load-configured', '1.1');
    assert.strictEqual(ocfl.object({ root: configured, ocflVersion: '1.0' }).ocflVersion, '1.0');
    const unconfigured = await existingObject('before-load-default', '1.0');
    assert.strictEqual(ocfl.object({ root: unconfigured }).ocflVersion, '1.1');
  });

  it('leaves the version of an existing object unchanged on update', async () => {
    const root = await existingObject('update-unchanged', '1.0');
    const o = ocfl.object({ root, ocflVersion: '1.1' });
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.deepStrictEqual(
      (await fs.promises.readdir(root)).filter((f) => f.startsWith('0=')),
      ['0=ocfl_object_1.0'],
    );
    const { type } = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')) as Inventory;
    assert.strictEqual(type, 'https://ocfl.io/1.0/spec/#inventory');
  });
});
