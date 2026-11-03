import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ocflTests from '@ocfl/ocfl-tests';
import ocfl from '../src/index.ts';

describe('OcflStorage class using OcflFsStore', () => {
  ocflTests.storage(ocfl);
});

describe('OcflStorage with an unsupported layout or object reference', () => {
  let tempdir;
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
    await assert.rejects(ocfl.storage({ root }).load(), { message: 'Layout "no-such-layout" is not supported.' });
  });

  it('rejects creating a layout with an unsupported extension name', () => {
    assert.throws(() => ocfl.StorageLayout.HashedNTupleStorageLayout.create({ extensionName: 'no-such-extension' }), {
      message: 'Extension "no-such-extension" is not supported.',
    });
  });

  it('creates a layout from a config object naming the extension', () => {
    const storage = ocfl.storage({
      root: path.join(tempdir, 'layout-config'),
      layout: { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: 4 },
    });
    const [firstTuple] = storage.objectRoot('an-object').split('/');
    assert.strictEqual(firstTuple.length, 4);
  });

  it('rejects an object reference with neither id nor root', () => {
    const storage = ocfl.storage({ root: path.join(tempdir, 'object-ref'), layout: 'HashedNTupleStorageLayout' });
    assert.throws(() => storage.object({}), { name: 'TypeError', message: '[OcflStorage] object id or root is required.' });
  });
});
