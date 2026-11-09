import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, it } from 'node:test';
import { OcflObjectInventory, OcflObjectInventoryMut } from '../src/inventory.ts';
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
  for (const path of seen) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      assert.ok(!seen.has(segments.slice(0, depth).join('/')), `logical path ${path} is under a file`);
    }
  }
  const manifestPaths = Object.values(inv.manifest).flat();
  for (const [algorithm, block] of Object.entries(inv.fixity ?? {})) {
    for (const contentPath of Object.values(block).flat()) {
      assert.ok(manifestPaths.includes(contentPath), `${algorithm} fixity lists ${contentPath}, which is not in the manifest`);
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
    const inv = OcflObjectInventoryMut.newVersion(data);
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(typeof inv.versions.v1, 'object');
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 0);
  });

  it('can create new version from existing', async () => {
    const data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    const inv = OcflObjectInventoryMut.newVersion(data);
    //console.log(inv.toJSON());
    const data2 = inv.toJSON();
    assert.strictEqual(data2.head, 'v4');
    assert.deepStrictEqual(data2.versions.v4!.state, data.versions.v3.state);
  });

  it('can add file to a new version', () => {
    const inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    const data2 = inv.toJSON();
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.deepStrictEqual(data2.manifest, inv.manifest);
    assertHeadStateValid(inv);
  });

  it('can add file with identical content but different name', () => {
    const inv = OcflObjectInventoryMut.newVersion(data);
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
    assertHeadStateValid(inv);
  });

  it('can add file with identical content and name', () => {
    let inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventoryMut.newVersion(inv.toJSON());
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
    assertHeadStateValid(inv);
  });

  it('can add file with different content but identical name', () => {
    let inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventoryMut.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest.aabbccddeeff2![0], 'v2/content/test.txt');
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff2![0], 'test.txt');
    assert.strictEqual(inv.versions.v2!.state.aabbccddeeff2!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v1!.state).length, 1);
    assert.strictEqual(Object.keys(inv.versions.v2!.state).length, 1);
    assertHeadStateValid(inv);
  });

  it('can add same file after it has been deleted', () => {
    let inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventoryMut.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2'); // aabbccddeeff effectively deleted from v2
    inv = OcflObjectInventoryMut.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff'); // reinstatement
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v3!.state).length, 1);
    assertHeadStateValid(inv);
  });

  it('can add file with extra fixity', () => {
    const inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test1.txt', 'aabbccddeeff', { crc32: '12345678', size: '1024' });
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test1.txt');
    assert.strictEqual(inv.fixity!.crc32!['12345678']![0], 'v1/content/test1.txt');
    assert.strictEqual(inv.fixity!.size!['1024']![0], 'v1/content/test1.txt');
    assertHeadStateValid(inv);
  });

  it('can detect state change', () => {
    let inv = OcflObjectInventoryMut.newVersion(data);
    assert.ok(inv.isChanged);
    inv = OcflObjectInventoryMut.newVersion(inv);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);
    inv = OcflObjectInventoryMut.newVersion(inv);
    assert.ok(!inv.isChanged);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(!inv.isChanged);
    inv.add('test1.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);
  });

  it('makes an independent copy from toJSON', () => {
    const inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('a', 'd1');
    const copy = new OcflObjectInventory(inv.toJSON());
    inv.add('b', 'd2');
    assert.deepStrictEqual(copy.state, { d1: ['a'] });
    assert.strictEqual(copy.getDigest('a'), 'd1');
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
    let inv = OcflObjectInventoryMut.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![0], 'test.txt');
    inv = OcflObjectInventoryMut.newVersion(inv);
    inv.delete('test.txt');
    assert(!inv.versions.v2!.state.aabbccddeeff);
    inv = OcflObjectInventoryMut.newVersion(inv);
    inv.reinstate('test.txt', 'v1');
    assert(inv.versions.v3!.state.aabbccddeeff);
    assertHeadStateValid(inv);
  });

  it('rejects iterating the files of an inventory whose head is not in versions', () => {
    const inv = new OcflObjectInventory(data);
    assert.throws(() => [...inv.files()], { code: 'E040' });
    assert.throws(() => [...inv.files('latest')], { code: 'E040' });
  });

  describe("'latest' version name", () => {
    let inv: ReturnType<typeof OcflObjectInventoryMut.newVersion>;
    beforeEach(() => {
      inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.add('a', 'd2', { md5: 'm2' });
    });

    it('resolves to head in getDigest and getFixity', () => {
      assert.strictEqual(inv.getDigest('a', 'latest'), 'd2');
      assert.deepStrictEqual(inv.getFixity('a', 'latest'), { md5: 'm2' });
    });

    it('reports the real version name from getFile', () => {
      const headFile = { logicalPath: 'a', version: 'v2', digest: 'd2', contentPath: 'v2/content/a', fixity: { md5: 'm2' } };
      assert.deepStrictEqual(inv.getFile('a', 'latest'), headFile);
      assert.deepStrictEqual(inv.getFile('a', 'v2'), headFile);
    });

    it('resolves to head in getFileByDigest and getFileByContentPath', () => {
      assert.strictEqual(inv.getFileByDigest('d2', 'latest')?.version, 'v2');
      assert.strictEqual(inv.getFileByContentPath('v2/content/a', 'latest')?.version, 'v2');
      assert.strictEqual(inv.getFileByDigest('d1', 'latest'), undefined);
    });

    it('resolves to head in reinstate', () => {
      assert.strictEqual(inv.reinstate('a', 'latest'), 1);
      assert.deepStrictEqual(inv.state, { d2: ['a'] });
    });

    it('treats an empty version name as a version that does not exist', () => {
      assert.strictEqual(inv.versionState(''), undefined);
      assert.deepStrictEqual([...inv.files('')], []);
      assert.strictEqual(inv.getDigest('a', ''), undefined);
      assert.deepStrictEqual(inv.getFixity('a', ''), {});
      assert.strictEqual(inv.getFile('a', ''), undefined);
      assert.strictEqual(inv.getFileByDigest('d2', ''), undefined);
      assert.strictEqual(inv.getFileByContentPath('v2/content/a', ''), undefined);
      assert.strictEqual(inv.reinstate('a', ''), 0);
      assert.deepStrictEqual(inv.state, { d2: ['a'] });
    });

    it('leaves explicit older versions unchanged', () => {
      assert.strictEqual(inv.getDigest('a', 'v1'), 'd1');
      assert.deepStrictEqual(inv.getFixity('a', 'v1'), { md5: 'm1' });
      assert.deepStrictEqual(inv.getFile('a', 'v1'), {
        logicalPath: 'a',
        version: 'v1',
        digest: 'd1',
        contentPath: 'v1/content/a',
        fixity: { md5: 'm1' },
      });
      assert.strictEqual(inv.getFileByDigest('d1', 'v1')?.logicalPath, 'a');
      assert.strictEqual(inv.getFileByContentPath('v1/content/a', 'v1')?.version, 'v1');
    });
  });

  describe('head version state stays valid', () => {
    it('moves an updated logical path to a digest that already has other paths', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1');
      inv.add('b', 'd2');
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('a', 'd2'), true);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assert.deepStrictEqual([...inv.files()].map((f) => f.logicalPath).sort(), ['a', 'b']);
      assert.strictEqual(inv.getDigest('a'), 'd2');
      assertHeadStateValid(inv);
      assert.strictEqual(inv.add('a', 'd2'), false);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assertHeadStateValid(inv);
    });

    for (const op of ['copy', 'rename'] as const) {
      describe(`${op}() target`, () => {
        function inventoryWith(files: Record<string, string>) {
          const inv = OcflObjectInventoryMut.newVersion(data);
          for (const [logicalPath, digest] of Object.entries(files)) {
            inv.add(logicalPath, digest);
          }
          return inv;
        }

        const refused: [string, Record<string, string>, string, string, string][] = [
          ['an existing file with different content', { a: 'd1', b: 'd2' }, 'a', 'b', 'FILE_EXISTS'],
          ['an existing file with identical content', { a: 'd1', b: 'd1' }, 'a', 'b', 'FILE_EXISTS'],
          ['the same path as source and target', { a: 'd1' }, 'a', 'a', 'FILE_EXISTS'],
          ['a directory with content', { a: 'd1', 'y/f': 'd2' }, 'a', 'y', 'FILE_EXISTS'],
          ['a target inside an existing file', { a: 'd1', b: 'd2' }, 'a', 'b/c/d', 'FILE_EXISTS'],
          ['a directory source onto non-overlapping content', { 'x/a': 'd1', 'x/b': 'd2', 'y/c': 'd3' }, 'x', 'y', 'FILE_EXISTS'],
          ['a dot-prefixed form of an existing file', { a: 'd1', b: 'd2' }, 'a', './b', 'FILE_EXISTS'],
          ['a doubled-slash form of a path inside a file', { a: 'd1', b: 'd2' }, 'a', 'b//c', 'FILE_EXISTS'],
          ['a missing source, even onto an existing file', { a: 'd1' }, 'missing', 'a', 'FILE_NOT_FOUND'],
        ];

        for (const [name, files, source, target, code] of refused) {
          it(`throws ${code} for ${name}, changing nothing`, () => {
            const inv = inventoryWith(files);
            const before = inv.toJSON();
            assert.throws(() => inv[op](source, target), { name: 'OcflError', code });
            assert.deepStrictEqual(inv.toJSON(), before);
            assertHeadStateValid(inv);
          });
        }

        it('rejects an empty target', () => {
          for (const target of ['', '.', './']) {
            assert.throws(() => inventoryWith({ a: 'd1' })[op]('a', target), { message: 'Target logical path cannot be empty' });
          }
        });

        it('throws FILE_NOT_FOUND for a missing source with an empty target', () => {
          assert.throws(() => inventoryWith({ a: 'd1' })[op]('missing', ''), { name: 'OcflError', code: 'FILE_NOT_FOUND' });
        });

        for (const target of ['./c', 'c/', './/c//']) {
          it(`records the target ${target} under its normalised path`, () => {
            const inv = inventoryWith({ a: 'd1', b: 'd2' });
            inv[op]('a', target);
            assert.strictEqual(inv.getDigest('c'), 'd1');
            assert.throws(() => inv[op]('b', 'c'), { name: 'OcflError', code: 'FILE_EXISTS' });
            assert.throws(() => inv[op]('b', target), { name: 'OcflError', code: 'FILE_EXISTS' });
            assertHeadStateValid(inv);
          });
        }

        it('normalises a directory target', () => {
          const inv = inventoryWith({ 'x/a': 'd1' });
          inv[op]('x', './y//z/');
          assert.strictEqual(inv.getDigest('y/z/a'), 'd1');
          assertHeadStateValid(inv);
        });

        it('accepts a target that only shares a name prefix with an existing path', () => {
          const inv = inventoryWith({ a: 'd1', bc: 'd2', 'bd/e': 'd3' });
          inv[op]('a', 'b');
          assert.strictEqual(inv.getDigest('b'), 'd1');
          assertHeadStateValid(inv);
        });

        it('accepts a target whose path was deleted first', () => {
          const inv = inventoryWith({ a: 'd1', b: 'd2' });
          inv.delete('b');
          inv[op]('a', 'b');
          assert.strictEqual(inv.getDigest('b'), 'd1');
          assertHeadStateValid(inv);
        });

        it('moves every path of a directory source to a free target', () => {
          const inv = inventoryWith({ 'x/a': 'd1', 'x/s/b': 'd2' });
          inv[op]('x', 'y/z');
          assert.strictEqual(inv.getDigest('y/z/a'), 'd1');
          assert.strictEqual(inv.getDigest('y/z/s/b'), 'd2');
          assert.strictEqual(inv.getDigest('x/a'), op === 'copy' ? 'd1' : undefined);
          assertHeadStateValid(inv);
        });
      });
    }

    it('reinstates a logical path without dropping other paths with the same digest', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('x', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.delete('x');
      inv.add('y', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.reinstate('x', 'v1'), 1);
      assert.deepStrictEqual(inv.state, { d1: ['y', 'x'] });
      assert.strictEqual(inv.getDigest('y'), 'd1');
      assertHeadStateValid(inv);
    });

    it('reinstates a logical path over its current content', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('x', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.add('x', 'd2');
      inv.add('z', 'd2');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.reinstate('x', 'v1');
      assert.deepStrictEqual(inv.state, { d2: ['z'], d1: ['x'] });
      assertHeadStateValid(inv);
    });

    it('deletes a directory and every path under it', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a/b', 'd1');
      inv.add('a/c', 'd1');
      inv.add('ab', 'd1');
      assert.strictEqual(inv.delete('a'), 2);
      assert.deepStrictEqual(inv.state, { d1: ['ab'] });
      assertHeadStateValid(inv);
    });

    it('leaves the state unchanged when reinstating an unchanged path', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('x', 'd1');
      inv.add('y', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.reinstate('x', 'v1');
      assert.deepStrictEqual(inv.state, { d1: ['x', 'y'] });
      assertHeadStateValid(inv);
    });

    it('reinstates a file over a directory, replacing the paths under it', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('x', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.delete('x');
      inv.add('x/y', 'd2');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.reinstate('x', 'v1');
      assert.deepStrictEqual(inv.state, { d1: ['x'] });
      assertHeadStateValid(inv);
    });
  });

  describe('deleting or renaming a logical path within the version being built', () => {
    function newContent() {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      return inv;
    }

    function committedContent() {
      return OcflObjectInventoryMut.newVersion(newContent());
    }

    it('delete drops the manifest and fixity entries of content nothing else uses', () => {
      const inv = newContent();
      assert.strictEqual(inv.delete('a'), 1);
      assert.deepStrictEqual(inv.manifest, {});
      assert.strictEqual(inv.fixity?.md5, undefined);
      assertHeadStateValid(inv);
    });

    it('delete moves shared content to a remaining path, with its fixity', () => {
      const inv = newContent();
      inv.copy('a', 'b');
      inv.delete('a');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'] });
      assert.deepStrictEqual(inv.fixity?.md5, { m1: ['v1/content/b'] });
      assert.deepStrictEqual(inv.getFile('b')?.contentPath, 'v1/content/b');
      assert.deepStrictEqual(inv.getFixity('b'), { md5: 'm1' });
      assertHeadStateValid(inv);
    });

    it('delete keeps content stored at a remaining path where it is', () => {
      const inv = newContent();
      inv.copy('a', 'b');
      inv.delete('b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assert.deepStrictEqual(inv.fixity?.md5, { m1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('delete drops the entry when a directory holds every path using the content', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('d/x', 'd1');
      inv.add('d/y', 'd1');
      assert.strictEqual(inv.delete('d'), 2);
      assert.deepStrictEqual(inv.manifest, {});
      assertHeadStateValid(inv);
    });

    it('delete leaves the manifest and fixity of committed content unchanged', () => {
      const inv = committedContent();
      inv.delete('a');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assert.deepStrictEqual(inv.fixity?.md5, { m1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('rename moves the manifest and fixity entries of a path this version stored', () => {
      const inv = newContent();
      inv.rename('a', 'x/b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/x/b'] });
      assert.deepStrictEqual(inv.fixity?.md5, { m1: ['v1/content/x/b'] });
      assert.deepStrictEqual(inv.getFixity('x/b'), { md5: 'm1' });
      assertHeadStateValid(inv);
    });

    it('rename leaves entries alone when the content is stored at another path', () => {
      const inv = newContent();
      inv.copy('a', 'b');
      inv.rename('b', 'c');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('rename leaves entries of committed content unchanged', () => {
      const inv = committedContent();
      inv.rename('a', 'b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assert.deepStrictEqual(inv.fixity?.md5, { m1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });
  });

  describe('replacing a logical path within the version being built', () => {
    it('moves shared content to the other logical path, with its fixity', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.add('b', 'd1', { md5: 'm1' });
      inv.add('a', 'd2', { md5: 'm2' });
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'], d2: ['v1/content/a'] });
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/b'], m2: ['v1/content/a'] } });
      assert.strictEqual(inv.getFile('b')?.contentPath, 'v1/content/b');
      assert.deepStrictEqual(inv.getFixity('b'), { md5: 'm1' });
      assertHeadStateValid(inv);
    });

    it('forgets content nothing uses once its logical path takes content stored elsewhere', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.add('b', 'd2', { md5: 'm2' });
      assert.strictEqual(inv.add('a', 'd2', { md5: 'm2' }), true);
      assert.deepStrictEqual(inv.manifest, { d2: ['v1/content/b'] });
      assert.deepStrictEqual(inv.fixity, { md5: { m2: ['v1/content/b'] } });
      assertHeadStateValid(inv);
    });

    it('moves content shared through copy()', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.copy('a', 'b');
      inv.add('a', 'd2', { md5: 'm2' });
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'], d2: ['v1/content/a'] });
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/b'], m2: ['v1/content/a'] } });
      assertHeadStateValid(inv);
    });

    it('leaves shared content where it is when the replaced path did not hold it', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1');
      inv.add('b', 'd1');
      inv.add('b', 'd2');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v1/content/b'] });
      assertHeadStateValid(inv);
    });

    it('never changes content, manifest entries or fixity from an earlier version', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.add('b', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.add('a', 'd2', { md5: 'm2' });
      inv.add('a', 'd3', { md5: 'm3' });
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d3: ['v2/content/a'] });
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/a'], m3: ['v2/content/a'] } });
      assert.deepStrictEqual(inv.state, { d1: ['b'], d3: ['a'] });
      assert.deepStrictEqual(inv.versionState('v1'), { d1: ['a', 'b'] });
      assertHeadStateValid(inv);
    });
  });

  describe('fixity only lists content paths in the manifest', () => {
    it('drops the digest and fixity of content replaced at its own content path', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.add('a', 'd2', { md5: 'm2' });
      assert.deepStrictEqual(Object.keys(inv.manifest), ['d2']);
      assert.deepStrictEqual(Object.keys(inv.fixity!.md5!), ['m2']);
      assertHeadStateValid(inv);
    });

    it('replaces content that had no fixity with content that has some', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1');
      inv.add('a', 'd2', { md5: 'm2' });
      assert.deepStrictEqual(Object.keys(inv.manifest), ['d2']);
      assertHeadStateValid(inv);
    });

    it('does not pollute Object.prototype from a crafted content path', () => {
      data.fixity = { polluted: { value: ['__proto__'] } };
      new OcflObjectInventory(data);
      const polluted = Object.hasOwn(Object.prototype, 'polluted');
      delete (Object.prototype as { polluted?: string }).polluted;
      assert.strictEqual(polluted, false);
    });

    it('records nothing new when a new logical path duplicates content', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('b.txt', 'd1', { md5: 'm1' }), true);
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/a.txt'] } });
      assert.deepStrictEqual(inv.getFixity('b.txt'), { md5: 'm1' });
      assertHeadStateValid(inv);
    });

    it('records nothing new when a logical path is rewritten unchanged', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('a.txt', 'd1', { md5: 'm1' }), false);
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/a.txt'] } });
      assertHeadStateValid(inv);
    });

    it('attaches a new value to the existing content path', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('b.txt', 'd1', { md5: 'm1' }), true);
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/a.txt'] } });
      assertHeadStateValid(inv);
    });

    it('keeps the existing value when a different one is supplied', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.add('b.txt', 'd1', { md5: 'other', crc32: 'c1' });
      assert.deepStrictEqual(inv.fixity, {
        md5: { m1: ['v1/content/a.txt'] },
        crc32: { c1: ['v1/content/a.txt'] },
      });
      assert.deepStrictEqual(inv.getFixity('b.txt'), { md5: 'm1', crc32: 'c1' });
      assertHeadStateValid(inv);
    });

    it('shows a newly attached value on every logical path sharing the content', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('a.txt', 'd1', { md5: 'm1' }), false);
      assert.deepStrictEqual(inv.getFixity('a.txt'), { md5: 'm1' });
      assert.deepStrictEqual(inv.getFixity('a.txt', 'v1'), { md5: 'm1' });
    });

    it('records nothing new when deleted content is written again', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1', { md5: 'm1' });
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.delete('a.txt');
      inv = OcflObjectInventoryMut.newVersion(inv);
      assert.strictEqual(inv.add('a.txt', 'd1', { md5: 'm1' }), true);
      assert.deepStrictEqual(inv.fixity, { md5: { m1: ['v1/content/a.txt'] } });
      assert.deepStrictEqual(inv.getFixity('a.txt'), { md5: 'm1' });
      assertHeadStateValid(inv);
    });

    it('keeps fixity from every content path of a digest when attaching a value', () => {
      data.head = 'v1';
      data.manifest = { d1: ['v1/content/a', 'v1/content/b'] };
      data.versions = { v1: { created: '2026-01-01T00:00:00Z', state: { d1: ['a'] } } };
      data.fixity = { md5: { m1: ['v1/content/a'] }, crc32: { c1: ['v1/content/b'] } };
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('c', 'd1', { sha256: 's1' });
      const expected = { md5: 'm1', crc32: 'c1', sha256: 's1' };
      assert.deepStrictEqual(inv.getFixity('a'), expected);
      assert.deepStrictEqual(inv.getFixity('c'), expected);
      assertHeadStateValid(inv);
    });

    it('reflects an assigned fixity block in file lookups', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: 'm1' });
      inv.fixity = { md5: { m2: ['v1/content/a'] } };
      assert.deepStrictEqual(inv.getFixity('a'), { md5: 'm2' });
    });

    it('ignores an empty fixity value', () => {
      const inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a', 'd1', { md5: '' });
      assert.strictEqual(inv.fixity, undefined);
    });

    it('does not count fixity alone as a change', () => {
      let inv = OcflObjectInventoryMut.newVersion(data);
      inv.add('a.txt', 'd1');
      inv = OcflObjectInventoryMut.newVersion(inv);
      inv.add('a.txt', 'd1', { md5: 'm1' });
      assert.strictEqual(inv.isChanged, false);
    });
  });
});
