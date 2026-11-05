import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, it } from 'node:test';
import { OcflObjectInventory } from '../src/inventory.ts';
import type { Inventory } from '../src/types.ts';

function assertHeadStateValid(inv: OcflObjectInventory) {
  const seen = new Set<string>();
  for (const [digest, paths] of Object.entries(inv.state)) {
    assert.ok(paths.length > 0, `digest ${digest} has no logical paths`);
    assert.ok(inv.manifest[digest], `digest ${digest} is not in the manifest`);
    for (const path of paths) {
      assert.ok(!seen.has(path), `logical path ${path} appears more than once`);
      seen.add(path);
      assert.strictEqual(inv.getDigest(path), digest, `index disagrees with state for ${path}`);
    }
  }
}

describe('OcflObjectInventory class', () => {
  let data: Inventory;
  beforeEach(() => {
    data = {
      id: 'id1',
      digestAlgorithm: 'sha512',
      type: `https://ocfl.io/1.1/spec/#inventory`,
      head: '',
      manifest: {},
      versions: {},
    };
  });

  it('can create empty inventory', () => {
    const inv = new OcflObjectInventory(data);
    //assert.strictEqual(digest, inv.cachedDigest);
    assert.strictEqual(data.id, inv.id);
    assert.strictEqual(data.digestAlgorithm, inv.digestAlgorithm);
    assert.strictEqual(data.type, inv.type);
    assert.strictEqual('content', inv.contentDirectory);
    assert.strictEqual('', inv.head);
  });

  it('can load inventory', async () => {
    const data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    const inv = new OcflObjectInventory(data);
    //assert.strictEqual(digest, await inv.digest());
    assert.strictEqual(data.id, inv.id);
    assert.strictEqual(data.digestAlgorithm, inv.digestAlgorithm);
    assert.strictEqual(data.type, inv.type);
  });

  it('can create new version', () => {
    const inv = OcflObjectInventory.newVersion(data);
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(typeof inv.versions.v1, 'object');
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 0);
  });

  it('can create new version from existing', async () => {
    const data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    const inv = OcflObjectInventory.newVersion(data);
    //console.log(inv.toJSON());
    const data2 = inv.toJSON();
    assert.strictEqual(data2.head, 'v4');
    assert.deepStrictEqual(data2.versions.v4!.state, data.versions.v3.state);
  });

  it('can add file to a new version', () => {
    const inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    const data2 = inv.toJSON();
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.deepStrictEqual(data2.manifest, inv.manifest);
  });

  it('can add file with identical content but different name', () => {
    const inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv.add('test2.txt', 'aabbccddeeff');
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.manifest).length, 1);
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![1], 'test2.txt');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff!.length, 2);
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 1);
  });

  it('can add file with identical content and name', () => {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.manifest).length, 1);
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 1);
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v2!.state).length, 1);
  });

  it('can add file with different content but identical name', () => {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest.aabbccddeeff2![0], 'v2/content/test.txt');
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff2![0], 'test.txt');
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff2!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 1);
    assert.strictEqual(Object.keys(inv.versions.v2!.state).length, 1);
  });

  it('can add same file after it has been deleted', () => {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2'); // aabbccddeeff effectively deleted from v2
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff'); // reinstatement
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v3!.state).length, 1);
  });

  it('can add file with extra fixity', () => {
    const inv = OcflObjectInventory.newVersion(data);
    inv.add('test1.txt', 'aabbccddeeff', { crc32: '12345678', size: '1024' });
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test1.txt');
    assert.strictEqual(inv.fixity!.crc32!['12345678']![0], 'v1/content/test1.txt');
    assert.strictEqual(inv.fixity!.size!['1024']![0], 'v1/content/test1.txt');
  });

  it('can detect state change', () => {
    let inv = OcflObjectInventory.newVersion(data);
    assert.ok(inv.isChanged);
    inv = OcflObjectInventory.newVersion(inv);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);
    inv = OcflObjectInventory.newVersion(inv);
    assert.ok(!inv.isChanged);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(!inv.isChanged);
    inv.add('test1.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);
  });

  it('can iterate files', async () => {
    const data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    const inv = new OcflObjectInventory(data);
    var files = [...inv.files()];
    assert.strictEqual(files[0]!.contentPath, 'v2/content/foo/bar.xml');
    assert.strictEqual(files[1]!.contentPath, 'v1/content/empty.txt');
    assert.strictEqual(files[2]!.contentPath, 'v1/content/image.tiff');
  });

  it('can reinstate removed file from older version', () => {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![0], 'test.txt');
    inv = OcflObjectInventory.newVersion(inv);
    inv.delete('test.txt');
    assert(!inv.versions.v2!.state.aabbccddeeff);
    inv = OcflObjectInventory.newVersion(inv);
    inv.reinstate('test.txt', 'v1');
    assert(inv.versions.v3!.state.aabbccddeeff);
  });

  describe('head version state stays valid', () => {
    it('moves an updated logical path to a digest that already has other paths', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv.add('a', 'd1');
      inv.add('b', 'd2');
      inv = OcflObjectInventory.newVersion(inv);
      assert.strictEqual(inv.add('a', 'd2'), true);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assert.deepStrictEqual([...inv.files()].map((f) => f.logicalPath).sort(), ['a', 'b']);
      assert.strictEqual(inv.getDigest('a'), 'd2');
      assertHeadStateValid(inv);
      assert.strictEqual(inv.add('a', 'd2'), false);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assertHeadStateValid(inv);
    });

    it('renames onto a logical path with the same digest', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv.add('a', 'd1');
      inv.add('b', 'd1');
      inv.rename('b', 'a');
      assert.deepStrictEqual(inv.state, { d1: ['a'] });
      assert.strictEqual(inv.getDigest('b'), undefined);
      assertHeadStateValid(inv);
    });

    it('renames onto a logical path with a different digest', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv.add('a', 'd1');
      inv.add('b', 'd2');
      inv.rename('b', 'a');
      assert.deepStrictEqual(inv.state, { d2: ['a'] });
      assert.strictEqual(inv.getDigest('a'), 'd2');
      assertHeadStateValid(inv);
    });

    it('leaves a logical path renamed to itself in place', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv.add('a', 'd1');
      inv.rename('a', 'a');
      assert.deepStrictEqual(inv.state, { d1: ['a'] });
      assertHeadStateValid(inv);
    });
  });
});
