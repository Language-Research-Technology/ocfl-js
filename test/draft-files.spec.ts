import assert from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Draft, DraftFile, Version } from '../src/index.ts';
import { createObject, DETAILS, sha512, useTempRoots } from './helpers/drafts.ts';
import { writeFiles } from './helpers/storage-roots.ts';

/** Each file of `version` as a draft lists it, keyed by logical path */
function draftFilesOf(version: Version): Map<string, DraftFile> {
  return new Map(Array.from(version.files, ([logicalPath, file]) => [logicalPath, { path: file.path, digest: file.digest }]));
}

/** The draft file at `logicalPath` holding `content` */
function draftFile(logicalPath: string, content: string): [string, DraftFile] {
  return [logicalPath, { path: logicalPath, digest: sha512(content) }];
}

describe('listing the files of a draft', () => {
  const temp = useTempRoots('ocfl-draft-files-');

  it('starts with the head version, and lists after each operation exactly what the committed version then has', async () => {
    const root = await temp.newRoot();
    const source = path.join(temp.dir, 'import-source');
    await writeFiles(source, { 'x.txt': 'x', 'sub/y.txt': 'y' });
    const v1 = await createObject(root, 'listed', { 'a.txt': 'a', 'dir/b.txt': 'b' });
    const v2 = await v1.update(DETAILS, (draft) => draft.write('a.txt', 'a2'));
    const seen: Map<string, DraftFile>[] = [];
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
    assert.deepStrictEqual(seen[0], draftFilesOf(v2.head));
    assert.deepStrictEqual(seen[1], draftFilesOf(v3.head));
    assert.deepStrictEqual(
      seen[1],
      new Map([
        draftFile('a.txt', 'a'),
        draftFile('c.txt', 'c'),
        draftFile('moved.txt', 'b'),
        draftFile('imported/x.txt', 'x'),
        draftFile('imported/sub/y.txt', 'y'),
      ]),
    );
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
      assert.deepStrictEqual(await files, new Map([draftFile('b.txt', 'b')]));
    });
  });

  it('gives a snapshot that later operations leave unchanged', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'snapshot', { 'a.txt': 'a', 'b.txt': 'b' });
    await object.update(DETAILS, async (draft) => {
      const files = await draft.files();
      await draft.write('a.txt', 'changed');
      await draft.remove('b.txt');
      await draft.write('c.txt', 'c');
      assert.deepStrictEqual(files, new Map([draftFile('a.txt', 'a'), draftFile('b.txt', 'b')]));
      assert.ok([...files.values()].every((file) => Object.isFrozen(file)));
    });
  });

  it("lists nothing in a new object's draft, and no directories", async () => {
    const root = await temp.newRoot();
    await root.create('new', DETAILS, async (draft) => {
      assert.deepStrictEqual(await draft.files(), new Map());
      await draft.write('deep/down/file.txt', 'f');
      assert.deepStrictEqual(await draft.files(), new Map([draftFile('deep/down/file.txt', 'f')]));
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
