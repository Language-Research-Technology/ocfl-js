import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import ocfl from '../src/index.ts';
import { fsError, stillOpen, trackOpendir, withFsFailure } from './fs-failures.ts';
import { ocflError } from './ocfl-error.ts';

describe('OcflStorage with an unsupported layout or object reference', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-storage-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('rejects an unsupported layout in ocfl_layout.json when loading', async () => {
    const root = path.join(tempdir, 'layout-file');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    await fs.promises.writeFile(path.join(root, 'ocfl_layout.json'), JSON.stringify({ extension: 'no-such-layout' }));
    await assert.rejects(ocfl.storage({ root }).load(), ocflError('UNSUPPORTED_LAYOUT'));
  });

  it('uses the layout named in ocfl_layout.json when its extension config has no name', async () => {
    const root = path.join(tempdir, 'layout-config-unnamed');
    const extension = '0004-hashed-n-tuple-storage-layout';
    await fs.promises.mkdir(path.join(root, 'extensions', extension), { recursive: true });
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    await fs.promises.writeFile(path.join(root, 'ocfl_layout.json'), JSON.stringify({ extension }));
    await fs.promises.writeFile(path.join(root, 'extensions', extension, 'config.json'), JSON.stringify({ tupleSize: 4 }));
    const storage = await ocfl.storage({ root }).load();
    const [firstTuple] = storage.objectRoot('an-object').split('/');
    assert.strictEqual(firstTuple!.length, 4);
  });

  it('rejects an unsupported layout named in the layout extension config when loading', async () => {
    const root = path.join(tempdir, 'layout-extension-config');
    const extension = '0004-hashed-n-tuple-storage-layout';
    await fs.promises.mkdir(path.join(root, 'extensions', extension), { recursive: true });
    await fs.promises.writeFile(path.join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    await fs.promises.writeFile(path.join(root, 'ocfl_layout.json'), JSON.stringify({ extension }));
    await fs.promises.writeFile(path.join(root, 'extensions', extension, 'config.json'), JSON.stringify({ extensionName: 'no-such-layout' }));
    await assert.rejects(ocfl.storage({ root }).load(), ocflError('UNSUPPORTED_LAYOUT'));
  });

  it('creates a layout from a config object naming the extension', () => {
    const storage = ocfl.storage({
      root: path.join(tempdir, 'layout-config'),
      layout: { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 4 },
    });
    const [firstTuple] = storage.objectRoot('an-object').split('/');
    assert.strictEqual(firstTuple!.length, 4);
  });

  it('rejects an object reference with neither id nor root', () => {
    const storage = ocfl.storage({ root: path.join(tempdir, 'object-ref'), layout: '0004-hashed-n-tuple-storage-layout' });
    assert.throws(() => storage.object({}), { name: 'TypeError', message: '[OcflStorage] object id or root is required.' });
  });

  it('rejects creating a storage root in a non-empty directory', async () => {
    const root = path.join(tempdir, 'not-empty');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, 'stray.txt'), 'x');
    await assert.rejects(ocfl.createStorage({ root, layout: '0004-hashed-n-tuple-storage-layout' }), ocflError('DIRECTORY_NOT_EMPTY'));
  });
});

describe('iterating a storage root', () => {
  let tempdir: string;
  let root: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-storage-iteration-'));
    root = path.join(tempdir, 'root');
    const storage = await ocfl.createStorage({ root, layout: '0004-hashed-n-tuple-storage-layout' });
    for (const id of ['a', 'b', 'c']) {
      await storage.object(`http://example.org/${id}`).update(async (t) => {
        await t.write('a.txt', id);
      });
    }
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('closes every directory it opened when the loop breaks early', async () => {
    const storage = await ocfl.storage({ root }).load();
    const opened = await trackOpendir(async () => {
      for await (const _o of storage) {
        break;
      }
    });
    assert.ok(opened.length > 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });

  it('closes every directory it opened when the loop body throws', async () => {
    const storage = await ocfl.storage({ root }).load();
    const opened = await trackOpendir(() =>
      assert.rejects(async () => {
        for await (const _o of storage) {
          throw new Error('stop');
        }
      }, /stop/),
    );
    assert.ok(opened.length > 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });

  it('closes every directory it opened and rethrows when a directory cannot be opened', async () => {
    const storage = await ocfl.storage({ root }).load();
    const secondLevel = (dirPath: string) => path.relative(root, dirPath).split(path.sep).length === 2;
    const opened = await trackOpendir(() =>
      withFsFailure('opendir', secondLevel, () =>
        assert.rejects(
          async () => {
            for await (const _o of storage) {
            }
          },
          { code: 'EIO' },
        ),
      ),
    );
    assert.ok(opened.length > 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });

  it('closes every directory it opened and rethrows when an object declaration cannot be read', async () => {
    const storage = await ocfl.storage({ root }).load();
    const objectRoot = storage.object('http://example.org/a').root;
    const opened = await trackOpendir(() =>
      withFsFailure(
        'readFile',
        (filePath) => path.dirname(filePath) === objectRoot,
        () =>
          assert.rejects(
            async () => {
              for await (const _o of storage) {
              }
            },
            { code: 'EACCES' },
          ),
        'EACCES',
      ),
    );
    assert.ok(opened.length > 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });
});

describe('checking whether a storage root exists', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-storage-exists-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('rethrows and closes the directory it opened when reading it fails', async () => {
    const storage = ocfl.storage({ root: tempdir, layout: '0004-hashed-n-tuple-storage-layout' });
    const opened = await trackOpendir(async () => {
      const read = mock.method(fs.Dir.prototype, 'read', async () => {
        throw fsError('EIO');
      });
      try {
        await assert.rejects(storage.exists(), { code: 'EIO' });
      } finally {
        read.mock.restore();
      }
    });
    assert.strictEqual(opened.length, 1);
    assert.deepStrictEqual(await stillOpen(opened), []);
  });

  it('rethrows when the root cannot be opened', async () => {
    const storage = ocfl.storage({ root: tempdir, layout: '0004-hashed-n-tuple-storage-layout' });
    await withFsFailure('opendir', tempdir, () => assert.rejects(storage.exists(), { code: 'EIO' }));
  });

  it('is true when the root is a file', async () => {
    const root = path.join(tempdir, 'a-file');
    await fs.promises.writeFile(root, 'x');
    assert.strictEqual(await ocfl.storage({ root, layout: '0004-hashed-n-tuple-storage-layout' }).exists(), true);
  });

  it('is false when the root does not exist', async () => {
    const root = path.join(tempdir, 'missing');
    assert.strictEqual(await ocfl.storage({ root, layout: '0004-hashed-n-tuple-storage-layout' }).exists(), false);
  });

  it('is false when a parent of the root is a file', async () => {
    const parent = path.join(tempdir, 'parent-file');
    await fs.promises.writeFile(parent, 'x');
    const root = path.join(parent, 'root');
    assert.strictEqual(await ocfl.storage({ root, layout: '0004-hashed-n-tuple-storage-layout' }).exists(), false);
  });

  it('rethrows when the root is not a directory and cannot be inspected', async () => {
    const root = path.join(tempdir, 'uninspectable');
    await fs.promises.writeFile(root, 'x');
    const storage = ocfl.storage({ root, layout: '0004-hashed-n-tuple-storage-layout' });
    await withFsFailure('stat', root, () => assert.rejects(storage.exists(), { code: 'EACCES' }), 'EACCES');
  });
});
