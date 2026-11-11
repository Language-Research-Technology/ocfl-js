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
  for (const path of seen) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      assert.ok(!seen.has(segments.slice(0, depth).join('/')), `logical path ${path} is under a file`);
    }
  }
  const usedDigests = new Set(Object.values(inv.versions).flatMap((v) => Object.keys(v.state)));
  for (const digest of Object.keys(inv.manifest)) {
    assert.ok(usedDigests.has(digest), `digest ${digest} is in the manifest but no version state uses it`);
  }
  const manifestPaths = Object.values(inv.manifest).flat();
  for (const [algorithm, block] of Object.entries(inv.fixity ?? {})) {
    for (const contentPath of Object.values(block).flat()) {
      assert.ok(manifestPaths.includes(contentPath), `${algorithm} fixity lists ${contentPath}, which is not in the manifest`);
    }
  }
  assertMatchesRebuilt(inv);
}

/** Lookups through the indexes kept up to date by changes match an inventory built from the same data */
function assertMatchesRebuilt(inv: OcflObjectInventory) {
  const rebuilt = new OcflObjectInventory(inv.toJSON());
  const paths = new Set(Object.values(inv.versions).flatMap((v) => Object.values(v.state).flat()));
  for (const version of Object.keys(inv.versions)) {
    for (const path of paths) {
      assert.deepStrictEqual(inv.getFile(path, version), rebuilt.getFile(path, version), `index disagrees with a rebuild for ${path} in ${version}`);
    }
  }
}

const copy = (inv: OcflObjectInventory, source: string, target: string, merge?: boolean) => inv._applyCopy(inv._planCopy(source, target, merge));
const rename = (inv: OcflObjectInventory, source: string, target: string, merge?: boolean) => inv._applyRename(inv._planRename(source, target, merge));
const reinstate = (inv: OcflObjectInventory, logicalPath: string, version: number) => inv._applyReinstate(inv._planReinstate(logicalPath, version));

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
    inv._add('test.txt', 'aabbccddeeff');
    const data2 = inv.toJSON();
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest.aabbccddeeff![0], 'v1/content/test.txt');
    assert.deepStrictEqual(data2.manifest, inv.manifest);
    assertHeadStateValid(inv);
  });

  it('can add file with identical content but different name', () => {
    const inv = OcflObjectInventory.newVersion(data);
    inv._add('test.txt', 'aabbccddeeff');
    inv._add('test2.txt', 'aabbccddeeff');
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
    let inv = OcflObjectInventory.newVersion(data);
    inv._add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv._add('test.txt', 'aabbccddeeff');
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
    let inv = OcflObjectInventory.newVersion(data);
    inv._add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv._add('test.txt', 'aabbccddeeff2');
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
    let inv = OcflObjectInventory.newVersion(data);
    inv._add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv._add('test.txt', 'aabbccddeeff2'); // aabbccddeeff effectively deleted from v2
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv._add('test.txt', 'aabbccddeeff'); // reinstatement
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff![0], 'test.txt');
    assert.strictEqual(inv.versions.v3!.state.aabbccddeeff!.length, 1);
    assert.strictEqual(Object.keys(inv.versions.v3!.state).length, 1);
    assertHeadStateValid(inv);
  });

  it('can detect state change', () => {
    let inv = OcflObjectInventory.newVersion(data);
    assert.ok(inv._isChanged);
    inv = OcflObjectInventory.newVersion(inv);
    inv._add('test.txt', 'aabbccddeeff');
    assert.ok(inv._isChanged);
    inv = OcflObjectInventory.newVersion(inv);
    assert.ok(!inv._isChanged);
    inv._add('test.txt', 'aabbccddeeff');
    assert.ok(!inv._isChanged);
    inv._add('test1.txt', 'aabbccddeeff');
    assert.ok(inv._isChanged);
  });

  it('makes an independent copy from toJSON', () => {
    const inv = OcflObjectInventory.newVersion(data);
    inv._add('a', 'd1');
    const copy = new OcflObjectInventory(inv.toJSON());
    inv._add('b', 'd2');
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
    let inv = OcflObjectInventory.newVersion(data);
    inv._add('test.txt', 'aabbccddeeff');
    assert.strictEqual(inv.versions.v1!.state.aabbccddeeff![0], 'test.txt');
    inv = OcflObjectInventory.newVersion(inv);
    inv._delete('test.txt');
    assert(!inv.versions.v2!.state.aabbccddeeff);
    inv = OcflObjectInventory.newVersion(inv);
    reinstate(inv, 'test.txt', 1);
    assert(inv.versions.v3!.state.aabbccddeeff);
    assertHeadStateValid(inv);
  });

  it('rejects iterating the files of an inventory whose head is not in versions', () => {
    const inv = new OcflObjectInventory(data);
    assert.throws(() => [...inv.files()], { code: 'E040' });
    assert.throws(() => [...inv.files('latest')], { code: 'E040' });
  });

  describe("'latest' version name", () => {
    let inv: ReturnType<typeof OcflObjectInventory.newVersion>;
    beforeEach(() => {
      inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      inv._add('a', 'd2');
      inv = new OcflObjectInventory({ ...inv.toJSON(), fixity: { md5: { m1: ['v1/content/a'], m2: ['v2/content/a'] } } });
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

    it('does not make the head a version to reinstate', () => {
      assert.throws(() => reinstate(inv, 'a', 2), { name: 'OcflError', code: 'FILE_NOT_FOUND' });
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
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv._add('b', 'd2');
      inv = OcflObjectInventory.newVersion(inv);
      assert.strictEqual(inv._add('a', 'd2'), true);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assert.deepStrictEqual([...inv.files()].map((f) => f.logicalPath).sort(), ['a', 'b']);
      assert.strictEqual(inv.getDigest('a'), 'd2');
      assertHeadStateValid(inv);
      assert.strictEqual(inv._add('a', 'd2'), false);
      assert.deepStrictEqual(inv.state, { d2: ['b', 'a'] });
      assertHeadStateValid(inv);
    });

    function inventoryWith(files: Record<string, string>) {
      const inv = OcflObjectInventory.newVersion(data);
      for (const [logicalPath, digest] of Object.entries(files)) {
        inv._add(logicalPath, digest);
      }
      return inv;
    }

    const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort());

    for (const [op, transfer] of [
      ['copy', copy],
      ['rename', rename],
    ] as const) {
      describe(`${op} target`, () => {
        const refused: [string, Record<string, string>, string, string, string][] = [
          ['a directory with content', { a: 'd1', 'y/f': 'd2' }, 'a', 'y', 'FILE_EXISTS'],
          ['a target inside an existing file', { a: 'd1', b: 'd2' }, 'a', 'b/c/d', 'FILE_EXISTS'],
          ['a doubled-slash form of a path inside a file', { a: 'd1', b: 'd2' }, 'a', 'b//c', 'FILE_EXISTS'],
          ['a directory source onto non-overlapping content', { 'x/a': 'd1', 'x/b': 'd2', 'y/c': 'd3' }, 'x', 'y', 'FILE_EXISTS'],
          ['a directory source onto a file', { 'x/a': 'd1', b: 'd2' }, 'x', 'b', 'FILE_EXISTS'],
          ['a directory source inside a file', { 'x/a': 'd1', b: 'd2' }, 'x', 'b/c', 'FILE_EXISTS'],
          ['a missing source, even onto an existing file', { a: 'd1' }, 'missing', 'a', 'FILE_NOT_FOUND'],
          ['a missing source, even as its own target', { a: 'd1' }, 'missing', 'missing', 'FILE_NOT_FOUND'],
          ['a directory source into itself', { 'x/a': 'd1' }, 'x', 'x/y', 'INVALID_LOGICAL_PATH'],
          ['a directory source into itself, un-normalised', { 'x/a': 'd1' }, './x/', 'x//y', 'INVALID_LOGICAL_PATH'],
          ['a file source below itself', { a: 'd1' }, 'a', 'a/b', 'INVALID_LOGICAL_PATH'],
          ['an empty target', { a: 'd1' }, 'a', '', 'INVALID_LOGICAL_PATH'],
          ['a target of .', { a: 'd1' }, 'a', '.', 'INVALID_LOGICAL_PATH'],
          ['a target of ./', { a: 'd1' }, 'a', './', 'INVALID_LOGICAL_PATH'],
          ['an empty source', { a: 'd1' }, '', 'b', 'INVALID_LOGICAL_PATH'],
          ['a missing source with an empty target', { a: 'd1' }, 'missing', '', 'INVALID_LOGICAL_PATH'],
        ];

        for (const [name, files, source, target, code] of refused) {
          it(`throws ${code} for ${name}, changing nothing`, () => {
            const inv = inventoryWith(files);
            const before = inv.toJSON();
            assert.throws(() => transfer(inv, source, target), { name: 'OcflError', code });
            assert.deepStrictEqual(inv.toJSON(), before);
            assertHeadStateValid(inv);
          });
        }

        for (const [name, source, target] of [
          ['the same path as source and target', 'a', 'a'],
          ['the same path spelled two ways', './a', 'a/'],
          ['the same directory as source and target', 'x', 'x'],
        ] as const) {
          it(`changes nothing for ${name}`, () => {
            const inv = inventoryWith({ a: 'd1', b: 'd1', 'x/c': 'd2' });
            const before = inv.toJSON();
            transfer(inv, source, target);
            assert.deepStrictEqual(inv.toJSON(), before);
            assertHeadStateValid(inv);
          });
        }

        for (const target of ['./c', 'c/', './/c//']) {
          it(`records the target ${target} under its normalised path, where a second ${op} replaces it`, () => {
            const inv = inventoryWith({ a: 'd1', b: 'd2' });
            transfer(inv, 'a', target);
            assert.strictEqual(inv.getDigest('c'), 'd1');
            transfer(inv, 'b', target);
            assert.strictEqual(inv.getDigest('c'), 'd2');
            assert.deepStrictEqual(Object.keys(inv.manifest), op === 'copy' ? ['d1', 'd2'] : ['d2']);
            assertHeadStateValid(inv);
          });
        }

        it('normalises a directory target', () => {
          const inv = inventoryWith({ 'x/a': 'd1' });
          transfer(inv, 'x', './y//z/');
          assert.strictEqual(inv.getDigest('y/z/a'), 'd1');
          assertHeadStateValid(inv);
        });

        it('accepts a target that only shares a name prefix with an existing path', () => {
          const inv = inventoryWith({ a: 'd1', bc: 'd2', 'bd/e': 'd3' });
          transfer(inv, 'a', 'b');
          assert.strictEqual(inv.getDigest('b'), 'd1');
          assertHeadStateValid(inv);
        });

        it('accepts a target whose path was deleted first', () => {
          const inv = inventoryWith({ a: 'd1', b: 'd2' });
          inv._delete('b');
          transfer(inv, 'a', 'b');
          assert.strictEqual(inv.getDigest('b'), 'd1');
          assertHeadStateValid(inv);
        });

        const refusedMerging: [string, Record<string, string>, string, string, string][] = [
          ['a file where the target has a directory', { 'x/a': 'd1', 'x/b': 'd2', 'y/a/c': 'd3' }, 'x', 'y', 'FILE_EXISTS'],
          ['a directory where the target has a file', { 'x/a/c': 'd1', 'x/b': 'd2', 'y/a': 'd3' }, 'x', 'y', 'FILE_EXISTS'],
          ['a directory source onto a file', { 'x/a': 'd1', b: 'd2' }, 'x', 'b', 'FILE_EXISTS'],
          ['a directory source inside a file', { 'x/a': 'd1', b: 'd2' }, 'x', 'b/c', 'FILE_EXISTS'],
          ['a file source onto a directory', { a: 'd1', 'y/f': 'd2' }, 'a', 'y', 'FILE_EXISTS'],
          ['a file onto the directory it is in', { 'y/a': 'd1' }, 'y/a', 'y', 'FILE_EXISTS'],
          ['a directory source into itself', { 'x/a': 'd1', 'x/y/b': 'd2' }, 'x', 'x/y', 'INVALID_LOGICAL_PATH'],
          ['a missing source', { 'y/a': 'd1' }, 'missing', 'y', 'FILE_NOT_FOUND'],
        ];

        for (const [name, files, source, target, code] of refusedMerging) {
          it(`throws ${code} when merging ${name}, changing nothing`, () => {
            const inv = inventoryWith(files);
            const before = inv.toJSON();
            assert.throws(() => transfer(inv, source, target, true), { name: 'OcflError', code });
            assert.deepStrictEqual(inv.toJSON(), before);
            assertHeadStateValid(inv);
          });
        }

        it('throws FILE_EXISTS for a directory source onto a directory with content when merge is false', () => {
          const inv = inventoryWith({ 'x/a': 'd1', 'y/a': 'd2' });
          assert.throws(() => transfer(inv, 'x', 'y', false), { name: 'OcflError', code: 'FILE_EXISTS' });
          assertHeadStateValid(inv);
        });

        const kept = (files: Record<string, string>) => (op === 'copy' ? files : {});
        const merged: [string, Record<string, string>, string, string, Record<string, string>, Record<string, string>][] = [
          [
            'a directory into one with no clashing files',
            { 'x/a': 'd1', 'x/s/b': 'd2', 'y/c': 'd3', 'y/s/d': 'd4' },
            'x',
            'y',
            { ...kept({ 'x/a': 'd1', 'x/s/b': 'd2' }), 'y/a': 'd1', 'y/s/b': 'd2', 'y/c': 'd3', 'y/s/d': 'd4' },
            op === 'copy' ? { d1: 'x/a', d2: 'x/s/b', d3: 'y/c', d4: 'y/s/d' } : { d1: 'y/a', d2: 'y/s/b', d3: 'y/c', d4: 'y/s/d' },
          ],
          [
            'a directory into one with files at the same paths',
            { 'x/a': 'd1', 'x/b': 'd2', 'y/a': 'd3', 'y/b': 'd2', 'y/c': 'd4' },
            'x',
            './y/',
            { ...kept({ 'x/a': 'd1', 'x/b': 'd2' }), 'y/a': 'd1', 'y/b': 'd2', 'y/c': 'd4' },
            op === 'copy' ? { d1: 'x/a', d2: 'x/b', d4: 'y/c' } : { d1: 'y/a', d2: 'y/b', d4: 'y/c' },
          ],
          [
            'a directory whose file shares content stored at a file it replaces',
            { 'y/a': 'd1', 'x/a': 'd2', 'x/b': 'd1' },
            'x',
            'y',
            { ...kept({ 'x/a': 'd2', 'x/b': 'd1' }), 'y/a': 'd2', 'y/b': 'd1' },
            op === 'copy' ? { d1: 'x/b', d2: 'x/a' } : { d1: 'y/b', d2: 'y/a' },
          ],
          [
            'a directory into the directory it is in',
            { 'y/x/a': 'd1', 'y/x/x/a': 'd2', 'y/a': 'd3' },
            'y/x',
            'y',
            { ...kept({ 'y/x/x/a': 'd2' }), 'y/a': 'd1', 'y/x/a': 'd2' },
            op === 'copy' ? { d1: 'y/a', d2: 'y/x/x/a' } : { d1: 'y/a', d2: 'y/x/a' },
          ],
          [
            'a directory into one with no content',
            { 'x/a': 'd1' },
            'x',
            'y/z',
            { ...kept({ 'x/a': 'd1' }), 'y/z/a': 'd1' },
            op === 'copy' ? { d1: 'x/a' } : { d1: 'y/z/a' },
          ],
          ['a file onto a file', { a: 'd1', b: 'd2' }, 'a', 'b', { ...kept({ a: 'd1' }), b: 'd1' }, op === 'copy' ? { d1: 'a' } : { d1: 'b' }],
        ];

        for (const [name, files, source, target, expected, manifest] of merged) {
          it(`merges ${name}`, () => {
            const inv = inventoryWith(files);
            transfer(inv, source, target, true);
            assert.deepStrictEqual(Object.fromEntries([...inv.files()].map((f) => [f.logicalPath, inv.getDigest(f.logicalPath)]).sort()), sorted(expected));
            assert.deepStrictEqual(sorted(inv.manifest), sorted(Object.fromEntries(Object.entries(manifest).map(([d, p]) => [d, [`v1/content/${p}`]]))));
            assertHeadStateValid(inv);
          });
        }
      });
    }

    describe('copy target', () => {
      for (const [name, target] of [
        ['an existing file with different content', 'b'],
        ['a dot-prefixed form of an existing file', './b'],
      ] as const) {
        it(`replaces ${name}, dropping content nothing else uses`, () => {
          const inv = inventoryWith({ a: 'd1', b: 'd2' });
          copy(inv, 'a', target);
          assert.deepStrictEqual(inv.state, { d1: ['a', 'b'] });
          assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
          assertHeadStateValid(inv);
        });
      }

      it('moves content stored at a replaced target to a path that still uses it', () => {
        const inv = inventoryWith({ a: 'd1', b: 'd2', c: 'd2' });
        copy(inv, 'a', 'b');
        assert.deepStrictEqual(inv.state, { d1: ['a', 'b'], d2: ['c'] });
        assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v1/content/c'] });
        assertHeadStateValid(inv);
      });

      it('leaves the content of an earlier version alone when its file is replaced', () => {
        const inv = OcflObjectInventory.newVersion(inventoryWith({ a: 'd1', b: 'd2' }));
        copy(inv, 'a', 'b');
        assert.deepStrictEqual(inv.state, { d1: ['a', 'b'] });
        assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v1/content/b'] });
        assert.deepStrictEqual(inv.versionState('v1'), { d1: ['a'], d2: ['b'] });
      });

      for (const [name, source, target] of [['an existing file with identical content', 'a', 'b']] as const) {
        it(`changes nothing for ${name}`, () => {
          const inv = inventoryWith({ a: 'd1', b: 'd1', 'x/c': 'd2' });
          const before = inv.toJSON();
          copy(inv, source, target);
          assert.deepStrictEqual(inv.toJSON(), before);
          assertHeadStateValid(inv);
        });
      }

      it('finds a source given un-normalised', () => {
        const inv = inventoryWith({ 'x/a': 'd1' });
        copy(inv, './x//a', 'b');
        copy(inv, './/x/', 'y');
        assert.deepStrictEqual(inv.state, { d1: ['x/a', 'b', 'y/a'] });
        assertHeadStateValid(inv);
      });

      it('lists every path of a directory source at a free target, keeping the source', () => {
        const inv = inventoryWith({ 'x/a': 'd1', 'x/s/b': 'd2', xy: 'd3' });
        copy(inv, 'x', 'y/z');
        assert.deepStrictEqual(inv.state, { d1: ['x/a', 'y/z/a'], d2: ['x/s/b', 'y/z/s/b'], d3: ['xy'] });
        assertHeadStateValid(inv);
      });
    });

    describe('rename target', () => {
      for (const [name, target] of [
        ['an existing file with different content', 'b'],
        ['a dot-prefixed form of an existing file', './b'],
      ] as const) {
        it(`replaces ${name}, dropping content nothing else uses and moving its own`, () => {
          const inv = inventoryWith({ a: 'd1', b: 'd2' });
          rename(inv, 'a', target);
          assert.deepStrictEqual(inv.state, { d1: ['b'] });
          assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'] });
          assertHeadStateValid(inv);
        });
      }

      it('plans the release of a replaced target before the move that takes its place', () => {
        const inv = inventoryWith({ a: 'd1', b: 'd2', c: 'd2' });
        assert.deepStrictEqual(inv._planRename('a', 'b').releases, [
          { digest: 'd2', from: 'v1/content/b', to: 'v1/content/c' },
          { digest: 'd1', from: 'v1/content/a', to: 'v1/content/b' },
        ]);
        rename(inv, 'a', 'b');
        assert.deepStrictEqual(inv.state, { d1: ['b'], d2: ['c'] });
        assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'], d2: ['v1/content/c'] });
        assertHeadStateValid(inv);
      });

      it('leaves the content of an earlier version alone when its file is replaced', () => {
        const inv = OcflObjectInventory.newVersion(inventoryWith({ a: 'd1', b: 'd2' }));
        rename(inv, 'a', 'b');
        assert.deepStrictEqual(inv.state, { d1: ['b'] });
        assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v1/content/b'] });
        assert.deepStrictEqual(inv.versionState('v1'), { d1: ['a'], d2: ['b'] });
      });

      it('only unlists the source when the target holds identical content, moving content stored at the source', () => {
        const inv = inventoryWith({ a: 'd1', b: 'd1' });
        rename(inv, 'a', 'b');
        assert.deepStrictEqual(inv.state, { d1: ['b'] });
        assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'] });
        assertHeadStateValid(inv);
      });

      it('finds a source given un-normalised', () => {
        const inv = inventoryWith({ 'x/a': 'd1', 'x/b': 'd2' });
        rename(inv, './x//a', 'b');
        rename(inv, './/x/', 'y');
        assert.deepStrictEqual(inv.state, { d1: ['b'], d2: ['y/b'] });
        assertHeadStateValid(inv);
      });

      it('moves every path of a directory source to a free target', () => {
        const inv = inventoryWith({ 'x/a': 'd1', 'x/s/b': 'd2', xy: 'd3' });
        rename(inv, 'x', 'y/z');
        assert.deepStrictEqual(inv.state, { d1: ['y/z/a'], d2: ['y/z/s/b'], d3: ['xy'] });
        assertHeadStateValid(inv);
      });
    });

    it('reinstates a logical path without dropping other paths with the same digest', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('x', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      inv._delete('x');
      inv._add('y', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      reinstate(inv, 'x', 1);
      assert.deepStrictEqual(inv.state, { d1: ['y', 'x'] });
      assert.strictEqual(inv.getDigest('y'), 'd1');
      assertHeadStateValid(inv);
    });

    it('reinstates a logical path over its current content', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('x', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      inv._add('x', 'd2');
      inv._add('z', 'd2');
      inv = OcflObjectInventory.newVersion(inv);
      reinstate(inv, 'x', 1);
      assert.deepStrictEqual(inv.state, { d2: ['z'], d1: ['x'] });
      assertHeadStateValid(inv);
    });

    it('deletes a directory and every path under it', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a/b', 'd1');
      inv._add('a/c', 'd1');
      inv._add('ab', 'd1');
      assert.strictEqual(inv._delete('a'), 2);
      assert.deepStrictEqual(inv.state, { d1: ['ab'] });
      assertHeadStateValid(inv);
    });

    it('leaves the state unchanged when reinstating an unchanged path', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('x', 'd1');
      inv._add('y', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      reinstate(inv, 'x', 1);
      assert.deepStrictEqual(inv.state, { d1: ['x', 'y'] });
      assertHeadStateValid(inv);
    });

    for (const [name, logicalPath] of [
      ['inside a file', 'a/b'],
      ['deep inside a file', 'a/b/c'],
      ['onto a directory', 'd'],
      ['onto a dot-prefixed form of a directory', './d'],
      ['onto a doubled-slash form of a path inside a file', 'a//b'],
    ] as const) {
      it(`throws FILE_EXISTS adding a file ${name}, changing nothing`, () => {
        const inv = OcflObjectInventory.newVersion(data);
        inv._add('a', 'd1');
        inv._add('d/x', 'd2');
        const before = inv.toJSON();
        assert.throws(() => inv._add(logicalPath, 'd3'), { name: 'OcflError', code: 'FILE_EXISTS' });
        assert.deepStrictEqual(inv.toJSON(), before);
        assertHeadStateValid(inv);
      });
    }

    it('adds a file where a directory was once every file under it has gone', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('d/x', 'd1');
      inv._add('d/sub/y', 'd2');
      inv._add('d/sub/z', 'd3');
      inv = OcflObjectInventory.newVersion(inv);
      inv._delete('d/x');
      rename(inv, 'd/sub/y', 'y');
      assert.throws(() => inv._add('d/sub', 'd4'), { name: 'OcflError', code: 'FILE_EXISTS' });
      assert.throws(() => inv._add('d', 'd4'), { name: 'OcflError', code: 'FILE_EXISTS' });
      inv._delete('d/sub/z');
      inv._add('d', 'd4');
      assert.deepStrictEqual(inv.state, { d2: ['y'], d4: ['d'] });
      assertHeadStateValid(inv);
    });

    for (const logicalPath of ['d/x', 'd']) {
      it(`throws FILE_EXISTS reinstating ${logicalPath} when it puts a file inside a file, changing nothing`, () => {
        let inv = OcflObjectInventory.newVersion(data);
        inv._add('d/x', 'd1');
        inv._add('d/y', 'd2');
        inv = OcflObjectInventory.newVersion(inv);
        inv._delete('d');
        inv._add('d', 'd3');
        const before = inv.toJSON();
        assert.throws(() => reinstate(inv, logicalPath, 1), { name: 'OcflError', code: 'FILE_EXISTS' });
        assert.deepStrictEqual(inv.toJSON(), before);
        assertHeadStateValid(inv);
      });
    }

    it('throws FILE_EXISTS reinstating a file where a directory is, changing nothing', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('x', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      inv._delete('x');
      inv._add('x/y', 'd2');
      inv = OcflObjectInventory.newVersion(inv);
      const before = inv.toJSON();
      assert.throws(() => reinstate(inv, 'x', 1), { name: 'OcflError', code: 'FILE_EXISTS' });
      assert.deepStrictEqual(inv.toJSON(), before);
      assertHeadStateValid(inv);
    });

    it('reinstates a directory file by file, replacing files at the same paths and keeping the rest', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('d/a', 'd1');
      inv._add('d/b', 'd2');
      inv._add('d/same', 'd3');
      inv = OcflObjectInventory.newVersion(inv);
      inv._delete('d/a');
      inv._add('d/b', 'd4');
      inv._add('d/new', 'd5');
      reinstate(inv, 'd', 1);
      assert.deepStrictEqual(inv.state, { d3: ['d/same'], d5: ['d/new'], d1: ['d/a'], d2: ['d/b'] });
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/d/a'], d2: ['v1/content/d/b'], d3: ['v1/content/d/same'], d5: ['v2/content/d/new'] });
      assertHeadStateValid(inv);
    });

    for (const version of [2, 3, 0, -1, 1.5, Number.NaN]) {
      it(`throws FILE_NOT_FOUND reinstating from version ${version}, which is not a committed version`, () => {
        let inv = OcflObjectInventory.newVersion(data);
        inv._add('x', 'd1');
        inv = OcflObjectInventory.newVersion(inv);
        inv._add('x', 'd2');
        const before = inv.toJSON();
        assert.throws(() => reinstate(inv, 'x', version), { name: 'OcflError', code: 'FILE_NOT_FOUND' });
        assert.deepStrictEqual(inv.toJSON(), before);
      });
    }

    for (const logicalPath of ['missing', 'x/y', 'xy', '']) {
      it(`throws FILE_NOT_FOUND reinstating "${logicalPath}", which the version did not have`, () => {
        let inv = OcflObjectInventory.newVersion(data);
        inv._add('x', 'd1');
        inv = OcflObjectInventory.newVersion(inv);
        inv._add('xy', 'd2');
        const before = inv.toJSON();
        assert.throws(() => reinstate(inv, logicalPath, 1), { name: 'OcflError', code: 'FILE_NOT_FOUND' });
        assert.deepStrictEqual(inv.toJSON(), before);
      });
    }

    it('finds a version by its number whatever the width of its name', () => {
      const version = (state: Record<string, string[]>) => ({ created: '2026-01-02T03:04:05Z', state });
      const inv = OcflObjectInventory.newVersion(
        new OcflObjectInventory({
          ...data,
          head: 'v003',
          manifest: { d1: ['v001/content/x'], d2: ['v2/content/x'] },
          versions: { v001: version({ d1: ['x'] }), v2: version({ d2: ['x'] }), v003: version({}) },
        }),
      );
      assert.strictEqual(inv.head, 'v004');
      reinstate(inv, './x', 1);
      assert.deepStrictEqual(inv.state, { d1: ['x'] });
      reinstate(inv, 'x', 2);
      assert.deepStrictEqual(inv.state, { d2: ['x'] });
      reinstate(inv, 'x', 2);
      assert.deepStrictEqual(inv.state, { d2: ['x'] });
      assertHeadStateValid(inv);
    });
  });

  describe('deleting or renaming a logical path within the version being built', () => {
    function newContent() {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      return inv;
    }

    function committedContent() {
      return OcflObjectInventory.newVersion(newContent());
    }

    it('delete drops the manifest entry of content nothing else uses', () => {
      const inv = newContent();
      assert.strictEqual(inv._delete('a'), 1);
      assert.deepStrictEqual(inv.manifest, {});
      assertHeadStateValid(inv);
    });

    it('delete moves shared content to a remaining path', () => {
      const inv = newContent();
      copy(inv, 'a', 'b');
      inv._delete('a');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'] });
      assert.deepStrictEqual(inv.getFile('b')?.contentPath, 'v1/content/b');
      assertHeadStateValid(inv);
    });

    it('delete keeps content stored at a remaining path where it is', () => {
      const inv = newContent();
      copy(inv, 'a', 'b');
      inv._delete('b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('delete drops the entry when a directory holds every path using the content', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('d/x', 'd1');
      inv._add('d/y', 'd1');
      assert.strictEqual(inv._delete('d'), 2);
      assert.deepStrictEqual(inv.manifest, {});
      assertHeadStateValid(inv);
    });

    it('delete leaves the manifest of committed content unchanged', () => {
      const inv = committedContent();
      inv._delete('a');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('rename moves the manifest entry of a path this version stored', () => {
      const inv = newContent();
      rename(inv, 'a', 'x/b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/x/b'] });
      assertHeadStateValid(inv);
    });

    it('rename leaves entries alone when the content is stored at another path', () => {
      const inv = newContent();
      copy(inv, 'a', 'b');
      rename(inv, 'b', 'c');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('rename leaves entries of committed content unchanged', () => {
      const inv = committedContent();
      rename(inv, 'a', 'b');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });
  });

  describe('reinstating over a logical path within the version being built', () => {
    function committedA() {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      return OcflObjectInventory.newVersion(inv);
    }

    it('drops the manifest entry of content nothing else uses', () => {
      const inv = committedA();
      inv._add('a', 'd2');
      reinstate(inv, 'a', 1);
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('moves shared content to a remaining path', () => {
      const inv = committedA();
      inv._add('a', 'd2');
      copy(inv, 'a', 'b');
      reinstate(inv, 'a', 1);
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v2/content/b'] });
      assertHeadStateValid(inv);
    });

    it('keeps content stored under a directory that a reinstated file is refused for', () => {
      const inv = committedA();
      inv._delete('a');
      inv._add('a/x', 'd2');
      inv._add('a/y', 'd3');
      assert.throws(() => reinstate(inv, 'a', 1), { name: 'OcflError', code: 'FILE_EXISTS' });
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v2/content/a/x'], d3: ['v2/content/a/y'] });
      assertHeadStateValid(inv);
    });
  });

  describe('replacing a logical path within the version being built', () => {
    it('moves shared content to the other logical path', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv._add('b', 'd1');
      inv._add('a', 'd2');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'], d2: ['v1/content/a'] });
      assert.strictEqual(inv.getFile('b')?.contentPath, 'v1/content/b');
      assertHeadStateValid(inv);
    });

    it('forgets content nothing uses once its logical path takes content stored elsewhere', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv._add('b', 'd2');
      assert.strictEqual(inv._add('a', 'd2'), true);
      assert.deepStrictEqual(inv.manifest, { d2: ['v1/content/b'] });
      assertHeadStateValid(inv);
    });

    it('moves content shared through copy()', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      copy(inv, 'a', 'b');
      inv._add('a', 'd2');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/b'], d2: ['v1/content/a'] });
      assertHeadStateValid(inv);
    });

    it('leaves shared content where it is when the replaced path did not hold it', () => {
      const inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv._add('b', 'd1');
      inv._add('b', 'd2');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d2: ['v1/content/b'] });
      assertHeadStateValid(inv);
    });

    it('never changes content or manifest entries from an earlier version', () => {
      let inv = OcflObjectInventory.newVersion(data);
      inv._add('a', 'd1');
      inv._add('b', 'd1');
      inv = OcflObjectInventory.newVersion(inv);
      inv._add('a', 'd2');
      inv._add('a', 'd3');
      assert.deepStrictEqual(inv.manifest, { d1: ['v1/content/a'], d3: ['v2/content/a'] });
      assert.deepStrictEqual(inv.state, { d1: ['b'], d3: ['a'] });
      assert.deepStrictEqual(inv.versionState('v1'), { d1: ['a', 'b'] });
      assertHeadStateValid(inv);
    });
  });

  describe('fixity block read from stored data', () => {
    it('does not pollute Object.prototype from a crafted content path', () => {
      data.fixity = { polluted: { value: ['__proto__'] } };
      new OcflObjectInventory(data);
      const polluted = Object.hasOwn(Object.prototype, 'polluted');
      delete (Object.prototype as { polluted?: string }).polluted;
      assert.strictEqual(polluted, false);
    });
  });
});
