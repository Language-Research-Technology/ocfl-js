import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ocflTests from '@ocfl/ocfl-tests';
import ocfl from '../src/index.ts';

describe('OcflObject class using OcflFsStore', () => {
  // it("constructor", function() {
  //   console.log(this.ocfl);
  //   assert.strictEqual(DIGEST.size(), 2);
  //   assert.strictEqual(DIGEST_FIXITY.size(), 5);
  // });

  ocflTests.object(ocfl);
});

describe('OcflObject with a malformed or missing inventory', () => {
  let tempdir;
  before(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-fs-object-'));
  });
  after(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  /** Create a one-file object, then rewrite its inventory (and sidecar) with `corrupt` */
  async function malformedObject(name, corrupt) {
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
      { message: 'Inventory head "v2" is not in versions.' },
    );
  });

  it('rejects loading an inventory whose head is not in versions', async () => {
    const o = await malformedObject('bad-head-load', (inv) => {
      inv.head = 'v2';
    });
    await assert.rejects(o.load(), { message: 'Inventory head "v2" is not in versions.' });
  });

  it('rejects reading a file whose digest is not in the manifest', async () => {
    let digest;
    const o = await malformedObject('bad-manifest', (inv) => {
      [digest] = Object.keys(inv.manifest);
      inv.manifest = {};
    });
    await o.load();
    const message = `Digest "${digest}" is not in the manifest of object "bad-manifest".`;
    assert.throws(() => o.getFile('a.txt'), { message });
    await assert.rejects(async () => [...(await o.files())], { message });
  });

  it('finds no file in a version that does not exist', async () => {
    const root = path.join(tempdir, 'missing-version');
    const o = ocfl.object({ id: 'missing-version', root });
    await o.update(async (t) => t.write('a.txt', 'a'));
    const { digest } = await o.fileByLogicalPath('a.txt');
    assert.strictEqual(await o.fileByDigest(digest, 'v9'), undefined);
    assert.strictEqual(await o.fileByLogicalPath('a.txt', 'v9'), undefined);
    assert.strictEqual(await o.count('v9'), 0);
  });

  it('rejects counting or listing files of an object without an inventory', async () => {
    const o = ocfl.object({ id: 'no-inventory', root: path.join(tempdir, 'no-inventory') });
    const message = 'OCFL Object "no-inventory" does not exist';
    await assert.rejects(o.count(), { message });
    await assert.rejects(o.files(), { message });
  });
});
