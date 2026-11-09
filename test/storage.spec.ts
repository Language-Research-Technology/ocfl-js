import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl from '../src/index.ts';
import { ocflError } from './ocfl-error.ts';
import ocflTests from './shared/index.ts';

describe('OcflStorage class using OcflFsStore', () => {
  ocflTests.storage(ocfl);
});

describe('OcflStorage with an unsupported layout or object reference', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-storage-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('rejects an unsupported layout in the config', () => {
    assert.throws(() => ocfl.storage({ root: path.join(tempdir, 'config'), layout: 'no-such-layout' }), {
      message: 'Layout "no-such-layout" is not supported.',
    });
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

  it('rejects creating a layout with an unsupported extension name', () => {
    assert.throws(() => ocfl.extensions.HashedNTupleStorageLayout.create({ extensionName: 'no-such-extension' }), {
      message: 'Extension "no-such-extension" is not supported.',
    });
  });

  it('creates a layout from a config object naming the extension', () => {
    const storage = ocfl.storage({
      root: path.join(tempdir, 'layout-config'),
      layout: { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 4 },
    });
    const [firstTuple] = storage.objectRoot('an-object').split('/');
    assert.strictEqual(firstTuple!.length, 4);
  });

  it('deletes an object on a backend that rejects stat on a directory', async () => {
    const root = path.join(tempdir, 'no-directory-stat');
    const created = await ocfl.createStorage({ root, layout: 'FlatDirectStorageLayout' });
    await created.object('an-object').update(async (t) => {
      await t.write('a.txt', 'a');
    });
    const stat = async () => {
      throw Object.assign(new Error('no such key'), { code: 'ENOENT' });
    };
    const storage = await ocfl.loadStorage({ root }, { fs: { ...fs, promises: { ...fs.promises, stat } } as typeof fs });
    await storage.remove('an-object');
    assert.strictEqual(fs.existsSync(path.join(root, 'an-object')), false);
  });

  it('rejects an object reference with neither id nor root', () => {
    const storage = ocfl.storage({ root: path.join(tempdir, 'object-ref'), layout: 'HashedNTupleStorageLayout' });
    assert.throws(() => storage.object({}), { name: 'TypeError', message: '[OcflStorage] object id or root is required.' });
  });

  it('rejects creating a storage root in a non-empty directory', async () => {
    const root = path.join(tempdir, 'not-empty');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, 'stray.txt'), 'x');
    await assert.rejects(ocfl.createStorage({ root, layout: 'HashedNTupleStorageLayout' }), ocflError('DIRECTORY_NOT_EMPTY'));
  });
});
