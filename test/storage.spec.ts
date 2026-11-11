import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl, { type LegacyOcflObject as OcflObject } from '../src/index.ts';
import { stillOpen, trackOpendir, withFsFailure } from './fs-failures.ts';

describe('OcflStorage with an unsupported layout or object reference', () => {
  let tempdir: string;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-storage-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('rejects an object reference with neither id nor root', () => {
    const storage = ocfl.storage({ root: path.join(tempdir, 'object-ref'), layout: '0004-hashed-n-tuple-storage-layout' });
    assert.throws(() => storage.object({}), { name: 'TypeError', message: '[OcflStorage] object id or root is required.' });
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

  it('does not look for objects in the extensions directory while an update is in progress', async () => {
    const storage = await ocfl.storage({ root }).load();
    let first: OcflObject | undefined;
    for await (const o of storage) {
      first ??= o;
    }
    const inProgress = (await first!.update())!;
    await inProgress.write('in-progress.txt', 'x');
    try {
      const opened = await trackOpendir(async () => {
        for await (const _o of storage) {
        }
      });
      const extensions = path.join(storage.root, 'extensions');
      assert.deepStrictEqual(
        opened.map((d) => d.path).filter((p) => p === extensions || p.startsWith(extensions + path.sep)),
        [],
      );
    } finally {
      await inProgress.rollback();
    }
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
