import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createFsFromVolume, Volume } from 'memfs';
import ocfl from '../src/index.ts';
import ocflTests from './shared/index.ts';

describe('OcflObjectTransaction using OcflFsStore', () => {
  ocflTests.transaction(ocfl);
});

describe('OcflObjectTransaction using a memfs store', () => {
  it('writes an object through update() and reads the file back', async () => {
    const fs = createFsFromVolume(new Volume());
    const storage = await ocfl.createStorage({ root: '/ocfl/memfs' }, { fs: fs as unknown as typeof import('node:fs') });
    await storage.object('an-object').update(async (t) => {
      await t.write('data/a.txt', 'in memory');
    });

    const object = storage.object('an-object');
    await object.load();
    assert.strictEqual(await object.getFile('data/a.txt')?.text(), 'in memory');
    assert.strictEqual(fs.readFileSync(`/ocfl/memfs/${storage.objectRoot('an-object')}/v1/content/data/a.txt`, 'utf8'), 'in memory');
  });
});
