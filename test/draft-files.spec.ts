import assert from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Draft, Version } from '../src/index.ts';
import { createObject, DETAILS, sha512, useTempRoots } from './helpers/drafts.ts';
import { writeFiles } from './helpers/storage-roots.ts';

/** The digest of each file of `version`, keyed by logical path */
function digestsOf(version: Version): Map<string, string> {
  return new Map(Array.from(version.files, ([logicalPath, file]) => [logicalPath, file.digest]));
}

describe('listing the files of a draft', () => {
  const temp = useTempRoots('ocfl-draft-files-');

  it('starts with the head version, and lists after each operation exactly what the committed version then has', async () => {
    const root = await temp.newRoot();
    const source = path.join(temp.dir, 'import-source');
    await writeFiles(source, { 'x.txt': 'x', 'sub/y.txt': 'y' });
    const v1 = await createObject(root, 'listed', { 'a.txt': 'a', 'dir/b.txt': 'b' });
    const v2 = await v1.update(DETAILS, (draft) => draft.write('a.txt', 'a2'));
    const seen: Map<string, string>[] = [];
    const v3 = await v2.update(DETAILS, async (draft) => {
      seen.push(new Map(await draft.files()));
      await draft.write('c.txt', 'c');
      await draft.copy('dir', 'copied');
      await draft.rename('copied/b.txt', 'moved.txt');
      await draft.remove('dir');
      await draft.import(source, { target: 'imported' });
      await draft.reinstate('a.txt', 1);
      seen.push(new Map(await draft.files()));
    });
    assert.deepStrictEqual(seen[0], digestsOf(v2.head));
    assert.deepStrictEqual(seen[1], digestsOf(v3.head));
    assert.deepStrictEqual(Object.fromEntries(seen[1] ?? []), {
      'a.txt': sha512('a'),
      'c.txt': sha512('c'),
      'moved.txt': sha512('b'),
      'imported/x.txt': sha512('x'),
      'imported/sub/y.txt': sha512('y'),
    });
  });

  it('reflects operations started before it without awaiting them, and none started after', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'ordered', { 'a.txt': 'a' });
    await object.update(DETAILS, async (draft) => {
      const write = draft.write('b.txt', 'b');
      const remove = draft.remove('a.txt');
      const files = draft.files();
      const later = draft.write('c.txt', 'c');
      await Promise.all([write, remove, later]);
      assert.deepStrictEqual(await files, new Map([['b.txt', sha512('b')]]));
    });
  });

  it('gives a snapshot that later operations leave unchanged', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'snapshot', { 'a.txt': 'a' });
    await object.update(DETAILS, async (draft) => {
      const files = await draft.files();
      await draft.write('b.txt', 'b');
      await draft.remove('a.txt');
      assert.deepStrictEqual(files, new Map([['a.txt', sha512('a')]]));
    });
  });

  it("lists nothing in a new object's draft, and no directories", async () => {
    const root = await temp.newRoot();
    await root.create('new', DETAILS, async (draft) => {
      assert.deepStrictEqual(await draft.files(), new Map());
      await draft.write('deep/down/file.txt', 'f');
      assert.deepStrictEqual([...(await draft.files()).keys()], ['deep/down/file.txt']);
    });
  });

  it('throws Error once the update has finished', async () => {
    const root = await temp.newRoot();
    let kept: Draft | undefined;
    await root.create('finished', DETAILS, async (draft) => {
      kept = draft;
      await draft.write('a.txt', 'a');
    });
    await assert.rejects(async () => kept?.files(), { name: 'Error', message: /has finished/ });
  });
});
