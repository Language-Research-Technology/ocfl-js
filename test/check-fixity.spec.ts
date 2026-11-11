import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OcflError, openStorageRoot } from '../src/index.ts';
import { DIGESTS_OF_ABC } from './helpers/digests-of-abc.ts';
import { createObject, DETAILS, objectRootOf, sha512, snapshot, useTempRoots } from './helpers/drafts.ts';
import { rewriteInventory, SPEC_EX_FULL_ID, upperCased, writeFiles, writeForeignObject, writeSpecExFullRoot } from './helpers/storage-roots.ts';

describe('checking the fixity of an object', () => {
  const temp = useTempRoots('ocfl-check-fixity-');
  let count = 0;

  /** A new storage root holding a copy of the OCFL fixture object, in the directory `spec-ex-full` */
  async function fixtureRoot() {
    const rootPath = path.join(temp.dir, `fixture-${count++}`);
    await writeSpecExFullRoot(rootPath);
    return openStorageRoot(rootPath);
  }

  it('gives an empty list for an intact object', async () => {
    const object = await (await fixtureRoot()).open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(await object.checkFixity(), []);
  });

  it('reports a stored file whose content has changed, with the digest recorded and the digest found', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'changed', { 'a.txt': 'abc', 'b.txt': 'intact' });
    await fs.promises.writeFile(path.join(objectRootOf(root, 'changed'), 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual(await object.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512, actual: sha512('abd') },
    ]);
  });

  it('reports a stored file that is gone as missing, with no digest found', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'missing', { 'a.txt': 'abc', 'b.txt': 'intact' });
    await fs.promises.rm(path.join(objectRootOf(root, 'missing'), 'v1/content/a.txt'));
    assert.deepStrictEqual(await object.checkFixity(), [{ problem: 'missing', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512 }]);
  });

  it('reports every problem in the object, not just the first', async () => {
    const root = await temp.newRoot();
    let object = await createObject(root, 'several', { 'a.txt': 'abc', 'b.txt': 'b', 'c.txt': 'intact' });
    object = await object.update(DETAILS, (draft) => draft.write('d.txt', 'd'));
    const objectRoot = objectRootOf(root, 'several');
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/b.txt'));
    await fs.promises.writeFile(path.join(objectRoot, 'v2/content/d.txt'), 'e');
    assert.deepStrictEqual(await object.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512, actual: sha512('abd') },
      { problem: 'missing', contentPath: 'v1/content/b.txt', expected: sha512('b') },
      { problem: 'changed', contentPath: 'v2/content/d.txt', expected: sha512('d'), actual: sha512('e') },
    ]);
  });

  it('reports a stored file once, however many versions and logical paths it backs', async () => {
    const root = await temp.newRoot();
    let object = await createObject(root, 'shared', { 'a.txt': 'abc', 'copy.txt': 'abc' });
    object = await object.update(DETAILS, (draft) => draft.write('later.txt', 'abc'));
    assert.strictEqual(object.versions.size, 2);
    await fs.promises.writeFile(path.join(objectRootOf(root, 'shared'), 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual(await object.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512, actual: sha512('abd') },
    ]);
  });

  it('ignores files on disk that are not in the manifest', async () => {
    const root = await fixtureRoot();
    await writeFiles(path.join(root.path, 'spec-ex-full'), { 'v1/content/extra.txt': 'extra', 'extra.txt': 'extra' });
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(await object.checkFixity(), []);
  });

  it('ignores the fixity block, even when a value in it is wrong', async () => {
    const root = await fixtureRoot();
    await rewriteInventory(path.join(root.path, 'spec-ex-full'), (inventory) => {
      inventory.fixity = { md5: { [DIGESTS_OF_ABC.md5]: ['v1/content/foo/bar.xml'] } };
    });
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(await object.checkFixity(), []);
  });

  it('checks a sha256 object with sha256', async () => {
    const root = await temp.newRoot();
    const objectRoot = objectRootOf(root, 'sha256-object');
    await writeForeignObject(objectRoot, 'sha256-object', { 'a.txt': 'abc' }, { digestAlgorithm: 'sha256' });
    const object = await root.open('sha256-object');
    assert.deepStrictEqual(await object.checkFixity(), []);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual(await object.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha256, actual: createHash('sha256').update('abd').digest('hex') },
    ]);
  });

  it('matches digests the inventory records in upper case', async () => {
    const root = await temp.newRoot();
    await createObject(root, 'upper-case', { 'a.txt': 'abc', 'b.txt': 'b' });
    const objectRoot = objectRootOf(root, 'upper-case');
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest = upperCased(inventory.manifest!);
      inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
    });
    const object = await root.open('upper-case');
    assert.deepStrictEqual(await object.checkFixity(), []);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual(await object.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512.toUpperCase(), actual: sha512('abd') },
    ]);
  });

  it('checks only the versions the object knew about when it was opened', async () => {
    const root = await temp.newRoot();
    const opened = await createObject(root, 'earlier', { 'a.txt': 'abc' });
    const updated = await opened.update(DETAILS, (draft) => draft.write('later.txt', 'later'));
    const objectRoot = objectRootOf(root, 'earlier');
    await fs.promises.rm(path.join(objectRoot, 'v2/content/later.txt'));
    assert.deepStrictEqual(await opened.checkFixity(), []);
    assert.deepStrictEqual(await updated.checkFixity(), [{ problem: 'missing', contentPath: 'v2/content/later.txt', expected: sha512('later') }]);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual(await opened.checkFixity(), [
      { problem: 'changed', contentPath: 'v1/content/a.txt', expected: DIGESTS_OF_ABC.sha512, actual: sha512('abd') },
    ]);
  });

  it('throws the file system error when a stored file cannot be read, not a problem', { skip: process.getuid?.() === 0 }, async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'unreadable', { 'a.txt': 'abc', 'b.txt': 'b' });
    const objectRoot = objectRootOf(root, 'unreadable');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/b.txt'));
    const locked = path.join(objectRoot, 'v1/content/a.txt');
    await fs.promises.chmod(locked, 0o000);
    try {
      await assert.rejects(object.checkFixity(), (e) => !(e instanceof OcflError) && (e as NodeJS.ErrnoException).code === 'EACCES');
    } finally {
      await fs.promises.chmod(locked, 0o600);
    }
  });

  it('writes nothing to the storage root', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'read-only', { 'a.txt': 'abc', 'b.txt': 'b' });
    await fs.promises.rm(path.join(objectRootOf(root, 'read-only'), 'v1/content/b.txt'));
    const before = await snapshot(root.path);
    await object.checkFixity();
    assert.deepStrictEqual(await snapshot(root.path), before);
  });

  it('checks an object with more files than it reads at once', async () => {
    const root = await temp.newRoot();
    const names = Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
    const object = await createObject(root, 'many', Object.fromEntries(names.map((name) => [name, `content of ${name}`])));
    const objectRoot = objectRootOf(root, 'many');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/file-07.txt'));
    await fs.promises.rm(path.join(objectRoot, 'v1/content/file-33.txt'));
    const problems = await object.checkFixity();
    assert.deepStrictEqual(
      problems.map(({ problem, contentPath }) => [problem, contentPath]),
      [
        ['missing', 'v1/content/file-07.txt'],
        ['missing', 'v1/content/file-33.txt'],
      ],
    );
  });
});
