import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as entryPoint from '../src/index.ts';
import ocfl, { createStorage, loadStorage, OCFL_VERSIONS, type OcflObject, storage, storageLayout } from '../src/index.ts';

describe('the public entry point', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-public-api-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('offers nothing about storage backends', () => {
    for (const name of ['OcflStore', 'OcflFsStore', 'implementOcfl']) {
      assert.ok(!(name in entryPoint), `${name} is exported`);
    }
  });

  it('offers no way to add or reach layout classes', () => {
    for (const name of ['extensions', 'OcflExtension', 'OcflStorageLayout']) {
      assert.ok(!(name in entryPoint), `${name} is exported`);
    }
  });

  it('has no object() to open an object without its storage root', () => {
    assert.ok(!('object' in entryPoint), 'object is exported');
  });

  it('has a default export holding the same API as the named exports', () => {
    assert.deepStrictEqual(Object.keys(ocfl).sort(), ['OCFL_VERSIONS', 'createStorage', 'loadStorage', 'storage', 'storageLayout']);
    assert.strictEqual(ocfl.storage, storage);
    assert.strictEqual(ocfl.createStorage, createStorage);
    assert.strictEqual(ocfl.loadStorage, loadStorage);
    assert.strictEqual(ocfl.storageLayout, storageLayout);
    assert.strictEqual(ocfl.OCFL_VERSIONS, OCFL_VERSIONS);
  });

  it('lists the supported OCFL versions', () => {
    assert.deepStrictEqual([...OCFL_VERSIONS], ['1.1', '1.0']);
  });

  it('builds a storage layout from a name or a config', () => {
    assert.strictEqual(storageLayout('0002-flat-direct-storage-layout').map('abc'), 'abc');
    assert.strictEqual(storageLayout({ extensionName: '0002-flat-direct-storage-layout' }).map('abc'), 'abc');
  });

  it('creates a storage root on disk with createStorage', async () => {
    const root = path.join(dir, 'root');
    const created = await createStorage({ root });
    assert.strictEqual(created.root, root);
    assert.strictEqual(await fs.promises.readFile(path.join(root, '0=ocfl_1.1'), 'utf8'), 'ocfl_1.1\n');
  });

  it('loads an existing storage root with loadStorage', async () => {
    const root = path.join(dir, 'root');
    await createStorage({ root, layout: '0002-flat-direct-storage-layout' });
    const loaded = await loadStorage({ root });
    assert.strictEqual(loaded.objectRoot('abc'), 'abc');
  });

  it('creates a storage root on disk through storage', async () => {
    const root = path.join(dir, 'root');
    await storage({ root }).create();
    assert.ok(fs.existsSync(path.join(root, '0=ocfl_1.1')));
  });

  it('writes an object through its storage root and opens it again by its path relative to that root', async () => {
    const root = path.join(dir, 'root');
    const created = await createStorage({ root, layout: '0002-flat-direct-storage-layout' });
    await created.object('a').update(async (t) => t.write('a.txt', 'hello'));
    assert.strictEqual(await fs.promises.readFile(path.join(root, 'a/v1/content/a.txt'), 'utf8'), 'hello');
    const opened = (await loadStorage({ root })).object({ root: 'a' });
    await opened.load();
    assert.strictEqual(await opened.getFile('a.txt')!.text(), 'hello');
  });
});

describe('OcflObject readFile', () => {
  const bytes = [0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f];
  let dir: string;
  let o: OcflObject;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-read-file-'));
    o = (await createStorage({ root: path.join(dir, 'root'), layout: '0002-flat-direct-storage-layout' })).object('a');
    await o.update(async (t) => {
      await t.write('a.txt', new Uint8Array(bytes));
      await t.write('empty.txt', '');
    });
  });

  after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('decodes content when given an encoding name', async () => {
    assert.strictEqual(await o.readFile('v1/content/a.txt', 'utf8'), 'héllo');
  });

  it('decodes content when given an encoding option', async () => {
    assert.strictEqual(await o.readFile('v1/content/a.txt', { encoding: 'utf8' }), 'héllo');
  });

  it('encodes content as hex and base64', async () => {
    assert.strictEqual(await o.readFile('v1/content/a.txt', 'hex'), '68c3a96c6c6f');
    assert.strictEqual(await o.readFile('v1/content/a.txt', 'base64'), 'aMOpbGxv');
  });

  it('resolves an empty file to an empty string when given an encoding', async () => {
    assert.strictEqual(await o.readFile('v1/content/empty.txt', 'utf8'), '');
  });

  it('returns bytes unchanged when given no encoding', async () => {
    const result = await o.readFile('v1/content/a.txt');
    assert.ok(result instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(result), bytes);
  });
});
