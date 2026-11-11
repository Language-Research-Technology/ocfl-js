import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ocfl from '../src/index.ts';

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
