import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Inventory } from '@ocfl/ocfl';
import ocflTests from '@ocfl/ocfl-tests';
import ocfl, { ObjectNotFoundError, ObjectNotLoadedError } from '../src/index.ts';

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
    const message = 'OCFL Object "no-inventory" does not exist';
    await assert.rejects(o.count(), { message });
    await assert.rejects(o.files(), { message });
  });
});
