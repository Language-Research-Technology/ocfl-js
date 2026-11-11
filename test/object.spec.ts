import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl, { type Inventory, ObjectNotFoundError, ObjectNotLoadedError, type OcflVersion } from '../src/index.ts';
import type { OcflObject } from '../src/object.ts';
import { withFsFailure } from './fs-failures.ts';
import { writeStorageRoot } from './helpers/storage-roots.ts';
import { ocflError } from './ocfl-error.ts';
import { testObject } from './test-object.ts';

async function writeInventory(inventoryPath: string, data: string) {
  await fs.promises.writeFile(inventoryPath, data);
  await fs.promises.writeFile(`${inventoryPath}.sha512`, `${createHash('sha512').update(data).digest('hex')} inventory.json\n`);
}

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
    await testObject({ id: name, root }).update(async (t) => t.write('a.txt', 'a'));
    const inv = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8'));
    corrupt(inv);
    await writeInventory(path.join(root, 'inventory.json'), JSON.stringify(inv, null, 2));
    return testObject({ root });
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

  for (const [code, contentPath] of [
    ['E099', '../../outside'],
    ['E099', 'v1/content/../../../outside'],
    ['E099', 'v1/./content/a.txt'],
    ['E099', 'v1/content//a.txt'],
    ['E100', '/etc/passwd'],
    ['E100', 'v1/content/a.txt/'],
  ] as const) {
    it(`rejects loading an inventory with the content path ${contentPath} with ${code}`, async () => {
      const o = await malformedObject(`content-path-${code}-${contentPath.replaceAll('/', '_')}`, (inv) => {
        const [digest] = Object.keys(inv.manifest!);
        inv.manifest = { [digest!]: [contentPath] };
      });
      await assert.rejects(o.load(), { name: 'ValidationError', code, detail: `content path "${contentPath}"` });
    });
  }

  for (const [code, contentDirectory] of [
    ['E017', 'a/b'],
    ['E018', '.'],
    ['E018', '..'],
  ] as const) {
    it(`rejects loading an inventory with the contentDirectory ${contentDirectory} with ${code}`, async () => {
      const o = await malformedObject(`content-directory-${code}-${contentDirectory.replaceAll('/', '_')}`, (inv) => {
        inv.contentDirectory = contentDirectory;
      });
      await assert.rejects(o.load(), { name: 'ValidationError', code, detail: `contentDirectory "${contentDirectory}"` });
    });
  }

  for (const name of ['../v1', 'v0', 'v1a', '1']) {
    it(`rejects loading an inventory with the version name ${name} with E104`, async () => {
      const o = await malformedObject(`version-name-${name.replaceAll('/', '_')}`, (inv) => {
        inv.versions = { [name]: inv.versions!.v1! };
        inv.head = name;
      });
      await assert.rejects(o.load(), { name: 'ValidationError', code: 'E104', detail: `version "${name}"` });
    });
  }

  it('rejects loading an inventory without versions', async () => {
    const o = await malformedObject('no-versions', (inv) => {
      delete inv.versions;
    });
    await assert.rejects(o.load(), { name: 'ValidationError', code: 'E040' });
  });

  it('rejects reading an earlier version inventory with an unsafe content path', async () => {
    const root = path.join(tempdir, 'earlier-version-content-path');
    await testObject({ id: 'earlier', root }).update(async (t) => t.write('a.txt', 'a'));
    const earlier = path.join(root, 'v1', 'inventory.json');
    const inv = JSON.parse(await fs.promises.readFile(earlier, 'utf8'));
    const [digest] = Object.keys(inv.manifest);
    inv.manifest = { [digest!]: ['../outside'] };
    await writeInventory(earlier, JSON.stringify(inv));
    await assert.rejects(testObject({ root }).getInventory('v1'), { name: 'ValidationError', code: 'E099' });
  });

  it('finds no inventory for a version that is not a version name, without reading it', async () => {
    const root = path.join(tempdir, 'inventory-version-name');
    const o = testObject({ id: 'inventory-version-name', root });
    await o.update(async (t) => t.write('a.txt', 'a'));
    const nested = path.join(root, 'v1', 'content', 'x');
    await fs.promises.mkdir(nested, { recursive: true });
    await fs.promises.copyFile(path.join(root, 'inventory.json'), path.join(nested, 'inventory.json'));
    await fs.promises.copyFile(path.join(root, 'inventory.json.sha512'), path.join(nested, 'inventory.json.sha512'));
    for (const version of ['v1/content/x', '', '.', '../inventory-version-name/v1']) {
      assert.strictEqual(await o.getInventory(version), undefined, version);
    }
    assert.strictEqual((await o.getInventory('v1'))?.head, 'v1');
  });

  it('reads only inside the object root through its raw file methods', async () => {
    const root = path.join(tempdir, 'raw-reads', 'object');
    const o = testObject({ id: 'raw-reads', root });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await fs.promises.writeFile(path.join(tempdir, 'raw-reads', 'outside'), 'outside');
    const rejected = { name: 'OcflError', code: 'INVALID_PATH' };
    for (const p of ['../outside', 'v1/../../outside', path.join(root, 'v1/content/a.txt')]) {
      await assert.rejects(o.readFile(p, 'utf8'), rejected, p);
      await assert.rejects(o.stat(p), rejected, p);
      await assert.rejects(o.createReadable(p), rejected, p);
    }
    assert.strictEqual(await o.readFile('v1/content/a.txt', 'utf8'), 'a');
    assert.strictEqual((await o.stat('v1/content/a.txt')).size, 1);
    assert.strictEqual((await o.stat('.')).isDirectory(), true);
    assert.strictEqual(await new Response(await o.createReadable('v1/content/a.txt')).text(), 'a');
  });

  it('finds no file in a version that does not exist', async () => {
    const root = path.join(tempdir, 'missing-version');
    const o = testObject({ id: 'missing-version', root });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await o.load();
    const { digest } = o.getFile('a.txt')!;
    assert.strictEqual(o.getFile({ digest: digest!, version: 'v9' }), undefined);
    assert.strictEqual(o.getFile('a.txt', 'v9'), undefined);
    assert.strictEqual(await o.count('v9'), 0);
  });

  it('rejects a configured contentDirectory that is not a single directory name', () => {
    for (const contentDirectory of ['../../x', 'a/b', '.', '..']) {
      assert.throws(() => testObject({ id: 'x', root: path.join(tempdir, 'content-directory-config'), contentDirectory }), TypeError, contentDirectory);
    }
  });

  it('rejects a digestAlgorithm that is not lowercase', () => {
    // @ts-expect-error deliberately invalid
    assert.throws(() => testObject({ id: 'upper-digest', root: path.join(tempdir, 'upper-digest'), digestAlgorithm: 'SHA256' }), {
      message: 'Invalid digest algorithm. Must be one of `sha256` or `sha512`.',
    });
  });

  it('rejects an unsupported digestAlgorithm', () => {
    // @ts-expect-error deliberately invalid
    assert.throws(() => testObject({ id: 'md5-digest', root: path.join(tempdir, 'md5-digest'), digestAlgorithm: 'md5' }), {
      message: 'Invalid digest algorithm. Must be one of `sha256` or `sha512`.',
    });
  });

  it('replaces the previous version content when updating in REPLACE mode', async () => {
    const o = testObject({ id: 'replace-mode', root: path.join(tempdir, 'replace-mode') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await o.update(async (t) => t.write('b.txt', 'b'), { mode: 'REPLACE' });
    const paths = Array.from(await o.files(), (f) => f.logicalPath);
    assert.deepStrictEqual(paths, ['b.txt']);
  });

  it('keeps the previous version content when updating in the default MERGE mode', async () => {
    const o = testObject({ id: 'merge-mode', root: path.join(tempdir, 'merge-mode') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await o.update(async (t) => t.write('b.txt', 'b'));
    const paths = Array.from(await o.files(), (f) => f.logicalPath).sort();
    assert.deepStrictEqual(paths, ['a.txt', 'b.txt']);
  });

  it('rejects an unknown update mode', async () => {
    const o = testObject({ id: 'bad-mode', root: path.join(tempdir, 'bad-mode') });
    await assert.rejects(
      // @ts-expect-error deliberately invalid
      o.update(async (t) => t.write('a.txt', 'a'), { mode: 'APPEND' }),
      { name: 'TypeError', message: "Invalid mode 'APPEND'" },
    );
    await assert.rejects(
      // @ts-expect-error deliberately invalid
      o.update(async (t) => t.write('a.txt', 'a'), { mode: 'replace' }),
      { name: 'TypeError', message: "Invalid mode 'replace'" },
    );
  });

  it('exports the object errors for instanceof checks', async () => {
    const o = testObject({ id: 'exported-errors', root: path.join(tempdir, 'exported-errors') });
    assert.throws(() => o.getFile('a.txt'), ObjectNotLoadedError);
    await o.load();
    assert.throws(() => o.getFile('a.txt'), ObjectNotFoundError);
  });

  it('rejects counting or listing files of an object without an inventory', async () => {
    const o = testObject({ id: 'no-inventory', root: path.join(tempdir, 'no-inventory') });
    await assert.rejects(o.count(), ocflError('OBJECT_NOT_FOUND'));
    await assert.rejects(o.files(), ocflError('OBJECT_NOT_FOUND'));
  });

  it('rejects an update while another update of the same object is uncommitted', async () => {
    const o = testObject({ id: 'concurrent', root: path.join(tempdir, 'concurrent') });
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
      testObject({ id: 'not-empty', root }).update(async (t) => t.write('a.txt', 'a')),
      ocflError('DIRECTORY_NOT_EMPTY'),
    );
  });

  it('rejects creating an object when its root cannot be read, writing nothing', async () => {
    const root = path.join(tempdir, 'unreadable');
    await fs.promises.mkdir(root);
    const unreadable = (dirPath: string) => dirPath === root;
    await withFsFailure(
      'readdir',
      unreadable,
      () =>
        withFsFailure(
          'opendir',
          unreadable,
          () =>
            assert.rejects(
              testObject({ id: 'unreadable', root }).update(async (t) => t.write('a.txt', 'a')),
              { code: 'EACCES' },
            ),
          'EACCES',
        ),
      'EACCES',
    );
    assert.deepStrictEqual(await fs.promises.readdir(root), []);
  });

  it('rethrows from exists() when its root cannot be opened', async () => {
    const root = path.join(tempdir, 'unopenable');
    await fs.promises.mkdir(root);
    await withFsFailure('opendir', root, () => assert.rejects(testObject({ root }).exists(), { code: 'EACCES' }), 'EACCES');
  });

  it('rejects a logical path that is absolute or leaves the object', async () => {
    const o = testObject({ id: 'bad-path', root: path.join(tempdir, 'bad-path') });
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
    const o = testObject({ id: 'dot-name', root: path.join(tempdir, 'dot-name') });
    await o.update(async (t) => t.write('..notes.txt', 'x'));
    assert.strictEqual(await o.getFile('..notes.txt')?.text(), 'x');
  });

  it('rejects reading a lazy file the object does not contain', async () => {
    const root = path.join(tempdir, 'lazy-missing');
    await testObject({ id: 'lazy-missing', root }).update(async (t) => t.write('a.txt', 'a'));
    const file = testObject({ root }).getFile('missing.txt', undefined, true);
    await assert.rejects(file!.text(), ocflError('FILE_NOT_FOUND'));
  });

  it('rejects copying from a logical path the object does not contain', async () => {
    const o = testObject({ id: 'copy-missing', root: path.join(tempdir, 'copy-missing') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await assert.rejects(
      o.update(async (t) => t.copy('missing.txt', 'b.txt')),
      ocflError('FILE_NOT_FOUND'),
    );
  });

  it('rejects renaming a logical path the object does not contain', async () => {
    const o = testObject({ id: 'rename-missing', root: path.join(tempdir, 'rename-missing') });
    await o.update(async (t) => t.write('a.txt', 'a'));
    await assert.rejects(
      o.update(async (t) => t.rename('missing.txt', 'b.txt')),
      ocflError('FILE_NOT_FOUND'),
    );
  });

  async function assertFiles(o: ReturnType<typeof testObject>, expected: Record<string, string>) {
    const paths = Array.from(await o.files(), (f) => f.logicalPath).sort();
    assert.deepStrictEqual(paths, Object.keys(expected).sort());
    for (const [logicalPath, content] of Object.entries(expected)) {
      assert.strictEqual(await o.getFile(logicalPath)?.text(), content);
    }
  }

  for (const op of ['copy', 'rename'] as const) {
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
          const o = testObject({ id: `${op}-${index}`, root: path.join(tempdir, `${op}-occupied-${index}`) });
          await o.update(async (t) => {
            for (const [logicalPath, content] of Object.entries(files)) {
              await t.write(logicalPath, content);
            }
            await assert.rejects(t[op](source, target), ocflError('FILE_EXISTS'));
          });
          await assertFiles(o, files);
        });
      });

      it('throws FILE_NOT_FOUND for a missing source, even onto an existing file', async () => {
        const o = testObject({ id: `${op}-missing`, root: path.join(tempdir, `${op}-occupied-missing`) });
        await o.update(async (t) => t.write('a.txt', 'a'));
        await assert.rejects(
          o.update(async (t) => t[op]('missing.txt', 'a.txt')),
          ocflError('FILE_NOT_FOUND'),
        );
      });

      it('replaces a target removed first in the same transaction, keeping the earlier version', async () => {
        const o = testObject({ id: `${op}-removed`, root: path.join(tempdir, `${op}-occupied-removed`) });
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

  describe('a logical path that would be both a file and a directory', () => {
    const files = { a: 'a', 'd/x': 'x' };

    async function objectWithFiles(name: string) {
      const o = testObject({ id: name, root: path.join(tempdir, name) });
      await o.update(async (t) => {
        for (const [logicalPath, content] of Object.entries(files)) {
          await t.write(logicalPath, content);
        }
      });
      return o;
    }

    const writes = [
      ['inside a file of an earlier version', 'a/b'],
      ['deep inside a file of an earlier version', 'a/b/c'],
      ['onto a directory of an earlier version', 'd'],
      ['onto a doubled-slash form of a directory', './/d'],
    ] as const;

    writes.forEach(([name, target], index) => {
      it(`write() throws FILE_EXISTS ${name}, creating no version`, async () => {
        const o = await objectWithFiles(`conflict-write-${index}`);
        await o.update(async (t) => {
          await assert.rejects(t.write(target, 'new'), ocflError('FILE_EXISTS'));
        });
        assert.strictEqual(o.inventory?.head, 'v1');
        await assertFiles(o, files);
      });
    });

    it('write() throws FILE_EXISTS onto a directory written in the same update, keeping its files', async () => {
      const o = testObject({ id: 'conflict-same-update', root: path.join(tempdir, 'conflict-same-update') });
      await o.update(async (t) => {
        await t.write('d/x', 'x');
        await assert.rejects(t.write('d', 'new'), ocflError('FILE_EXISTS'));
        await assert.rejects(t.write('d/x/y', 'new'), ocflError('FILE_EXISTS'));
      });
      await assertFiles(o, { 'd/x': 'x' });
    });

    it('import() throws FILE_EXISTS for a file inside an existing file, importing nothing', async () => {
      const source = path.join(tempdir, 'conflict-import-source');
      await fs.promises.mkdir(path.join(source, 'a'), { recursive: true });
      await fs.promises.writeFile(path.join(source, 'a', 'inner.txt'), 'inner');
      await fs.promises.writeFile(path.join(source, 'ok.txt'), 'ok');
      const o = await objectWithFiles('conflict-import');
      await o.update(async (t) => {
        await assert.rejects(t.import(source), ocflError('FILE_EXISTS'));
      });
      assert.strictEqual(o.inventory?.head, 'v1');
      await assertFiles(o, files);
    });

    it('import() throws FILE_EXISTS for a file onto a directory, creating no version', async () => {
      const source = path.join(tempdir, 'conflict-import-source.txt');
      await fs.promises.writeFile(source, 'new');
      const o = await objectWithFiles('conflict-import-file');
      await assert.rejects(o.import([{ source, target: 'd' }]), ocflError('FILE_EXISTS'));
      assert.strictEqual(o.inventory?.head, 'v1');
      await assertFiles(o, files);
    });

    it('write() stores a logical path in its normalised form', async () => {
      const o = testObject({ id: 'conflict-normalised', root: path.join(tempdir, 'conflict-normalised') });
      await o.update(async (t) => {
        await t.write('./d//x', 'x');
        await t.write('./e/./y/', 'y');
        await assert.rejects(t.write('d', 'new'), ocflError('FILE_EXISTS'));
        await assert.rejects(t.write('e/y/z', 'new'), ocflError('FILE_EXISTS'));
        await t.write('d/x', 'replaced');
      });
      await assertFiles(o, { 'd/x': 'replaced', 'e/y': 'y' });
    });

    for (const logicalPath of ['', '.', './']) {
      it(`write() rejects the empty logical path "${logicalPath}"`, async () => {
        const o = await objectWithFiles(`conflict-empty-${logicalPath.length}`);
        await o.update(async (t) => {
          await assert.rejects(t.write(logicalPath, 'new'), ocflError('INVALID_LOGICAL_PATH'));
        });
        assert.strictEqual(o.inventory?.head, 'v1');
        await assertFiles(o, files);
      });
    }

    it('write() replaces an existing file', async () => {
      const o = await objectWithFiles('conflict-replace');
      await o.update(async (t) => t.write('d/x', 'changed'));
      await assertFiles(o, { a: 'a', 'd/x': 'changed' });
    });

    it('write() replaces a directory removed first in the same update', async () => {
      const o = await objectWithFiles('conflict-removed');
      await o.update(async (t) => {
        await t.remove('d');
        await t.write('d', 'file');
      });
      await assertFiles(o, { a: 'a', d: 'file' });
    });

    it('reinstate() throws FILE_EXISTS for a path inside a file, changing nothing', async () => {
      const o = await objectWithFiles('conflict-reinstate');
      await o.update(async (t) => {
        await t.remove('d');
        await t.write('d', 'file');
        await assert.rejects(t.reinstate('d/x', 'v1'), ocflError('FILE_EXISTS'));
        await assert.rejects(t.reinstate('d', 'v1'), ocflError('FILE_EXISTS'));
      });
      assert.strictEqual(o.inventory?.head, 'v2');
      await assertFiles(o, { a: 'a', d: 'file' });
    });

    it('reinstate() replaces a directory with the file an earlier version had there', async () => {
      const o = testObject({ id: 'conflict-reinstate-file', root: path.join(tempdir, 'conflict-reinstate-file') });
      await o.update(async (t) => t.write('x', 'file'));
      await o.update(async (t) => {
        await t.remove('x');
        await t.write('x/y', 'y');
      });
      await o.update(async (t) => {
        assert.strictEqual(await t.reinstate('x', 'v1'), 1);
      });
      await assertFiles(o, { x: 'file' });
    });
  });

  it('rejects an import target outside the object before reading any source', async () => {
    const source = path.join(tempdir, 'import-source.txt');
    await fs.promises.writeFile(source, 'x');
    const o = testObject({ id: 'import-fail', root: path.join(tempdir, 'import-fail') });
    await assert.rejects(o.import([{ source, target: '../escape.txt' }]), ocflError('INVALID_LOGICAL_PATH'));
  });

  it('rolls back and rethrows the update error when an earlier operation failed', async () => {
    const o = testObject({ id: 'rollback', root: path.join(tempdir, 'rollback') });
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
    const o = testObject({ id: 'import-dir', root: path.join(tempdir, 'import-dir-object') });
    try {
      await assert.rejects(o.import(dir));
      await assert.rejects(o.count(), ocflError('OBJECT_NOT_FOUND'));
    } finally {
      await fs.promises.chmod(path.join(dir, 'locked.txt'), 0o600);
    }
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
    await testObject({ id: name, root, ocflVersion }).update(async (t) => t.write('a.txt', 'a'));
    return root;
  }

  it('reports the version of a 1.0 object when none is configured', async () => {
    const o = testObject({ root: await existingObject('unconfigured', '1.0') });
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('reports the version of a 1.0 object in a 1.1 storage root', async () => {
    const root = path.join(tempdir, 'mixed-root');
    await writeStorageRoot(root, '1.0');
    const created = await ocfl.storage({ root }).load();
    await created.object('a').update(async (t) => t.write('a.txt', 'a'));
    await fs.promises.rm(path.join(root, '0=ocfl_1.0'));
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');

    const o = (await ocfl.storage({ root }).load()).object('a');
    assert.strictEqual(o.ocflVersion, '1.1');
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('ignores a configured version that differs from the object', async () => {
    const o = testObject({ root: await existingObject('configured-earlier', '1.1'), ocflVersion: '1.0' });
    await o.load();
    assert.strictEqual(o.ocflVersion, '1.1');
  });

  it('is correct after refresh on an object that has not been loaded', async () => {
    const o = testObject({ root: await existingObject('refresh', '1.0') });
    await o.refresh();
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('is correct after update on an object that has not been loaded', async () => {
    const o = testObject({ root: await existingObject('update', '1.0') });
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(o.ocflVersion, '1.0');
  });

  it('is not changed by reading an earlier version with an older inventory', async () => {
    const root = await existingObject('earlier-inventory', '1.1');
    const o = testObject({ root });
    await o.update(async (t) => t.write('b.txt', 'b'));
    const earlier = path.join(root, 'v1', 'inventory.json');
    const data = (await fs.promises.readFile(earlier, 'utf8')).replace('https://ocfl.io/1.1/spec/#inventory', 'https://ocfl.io/1.0/spec/#inventory');
    await writeInventory(earlier, data);

    const reader = testObject({ root });
    await reader.load();
    assert.strictEqual(reader.ocflVersion, '1.1');
    assert.strictEqual((await reader.getInventory('v1'))?.type, 'https://ocfl.io/1.0/spec/#inventory');
    assert.strictEqual(reader.ocflVersion, '1.1');
  });

  it('returns the configured version or the default before loading', async () => {
    const configured = await existingObject('before-load-configured', '1.1');
    assert.strictEqual(testObject({ root: configured, ocflVersion: '1.0' }).ocflVersion, '1.0');
    const unconfigured = await existingObject('before-load-default', '1.0');
    assert.strictEqual(testObject({ root: unconfigured }).ocflVersion, '1.1');
  });

  it('leaves the version of an existing object unchanged on update', async () => {
    const root = await existingObject('update-unchanged', '1.0');
    const o = testObject({ root, ocflVersion: '1.1' });
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.deepStrictEqual(
      (await fs.promises.readdir(root)).filter((f) => f.startsWith('0=')),
      ['0=ocfl_object_1.0'],
    );
    const { type } = JSON.parse(await fs.promises.readFile(path.join(root, 'inventory.json'), 'utf8')) as Inventory;
    assert.strictEqual(type, 'https://ocfl.io/1.0/spec/#inventory');
  });
});

describe('OcflObject with an active mutable head (extension 0005)', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-mutable-head-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  async function objectWithHead(name: string) {
    const root = path.join(tempdir, name);
    await testObject({ id: name, root }).update(async (t) => t.write('a.txt', 'a'));
    const headInventory = path.join(root, 'extensions', '0005-mutable-head', 'head', 'inventory.json');
    await fs.promises.mkdir(path.dirname(headInventory), { recursive: true });
    await fs.promises.copyFile(path.join(root, 'inventory.json'), headInventory);
    return { root, workspace: testObject({ root })._workspace, headInventory };
  }

  async function headVersion(root: string) {
    const o = testObject({ root });
    await o.load();
    return o.inventory?.head;
  }

  async function snapshot(dir: string) {
    const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries.map(async (e) => {
        const p = path.join(e.parentPath, e.name);
        return [path.relative(dir, p), e.isFile() ? await fs.promises.readFile(p, 'utf8') : null] as const;
      }),
    );
    return files.sort(([a], [b]) => a.localeCompare(b));
  }

  async function assertRefusedUnchanged(name: string, act: (o: OcflObject) => Promise<unknown>) {
    const { root, workspace } = await objectWithHead(name);
    const initial = await snapshot(root);
    await assert.rejects(act(testObject({ root })), ocflError('MUTABLE_HEAD_ACTIVE'));
    assert.deepStrictEqual(await snapshot(root), initial);
    assert.deepStrictEqual(await snapshot(workspace), []);
  }

  it('refuses update() with an updater, without calling it or changing anything', async () => {
    let called = false;
    await assertRefusedUnchanged('with-updater', (o) =>
      o.update(async (t) => {
        called = true;
        await t.write('b.txt', 'b');
      }),
    );
    assert.strictEqual(called, false);
  });

  it('refuses update() without an updater, returning no transaction and changing nothing', async () => {
    await assertRefusedUnchanged('without-updater', (o) => o.update());
  });

  it('refuses import(), changing nothing', async () => {
    const source = path.join(tempdir, 'import-source.txt');
    await fs.promises.writeFile(source, 'b');
    await assertRefusedUnchanged('import', (o) => o.import(source));
  });

  it('refuses an in-place update without leaving a lock, so a later update works once the head is gone', async () => {
    const { root, headInventory } = await objectWithHead('head-removed');
    const initial = await snapshot(root);
    const o = testObject({ root });
    await assert.rejects(
      o.update(async (t) => t.write('b.txt', 'b')),
      ocflError('MUTABLE_HEAD_ACTIVE'),
    );
    assert.deepStrictEqual(await snapshot(root), initial);
    await fs.promises.rm(headInventory);
    await o.update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(await headVersion(root), 'v2');
  });

  it('reports an object nested in another object before an active mutable head', async () => {
    const { root } = await objectWithHead('outer');
    const nested = path.join(root, 'nested');
    const nestedHead = path.join(nested, 'extensions', '0005-mutable-head', 'head', 'inventory.json');
    await fs.promises.mkdir(path.dirname(nestedHead), { recursive: true });
    await fs.promises.writeFile(nestedHead, '{}');
    await assert.rejects(
      testObject({ id: 'nested', root: nested }).update(async (t) => t.write('b.txt', 'b')),
      ocflError('E082'),
    );
  });

  it('allows update() when the extension directory has no head inventory', async () => {
    const { root, headInventory } = await objectWithHead('no-head-inventory');
    await fs.promises.rm(headInventory);
    await testObject({ root }).update(async (t) => t.write('b.txt', 'b'));
    assert.strictEqual(await headVersion(root), 'v2');
  });

  it('rethrows when the head inventory cannot be checked, changing nothing', async () => {
    const { root, headInventory } = await objectWithHead('unreadable-head');
    await fs.promises.rm(headInventory);
    const initial = await snapshot(root);
    await withFsFailure(
      'stat',
      headInventory,
      () =>
        assert.rejects(
          testObject({ root }).update(async (t) => t.write('b.txt', 'b')),
          { code: 'EACCES' },
        ),
      'EACCES',
    );
    assert.deepStrictEqual(await snapshot(root), initial);
  });
});
