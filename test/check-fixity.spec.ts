import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
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

  /** A new storage root holding a copy of the OCFL fixture object, in the directory `spec-ex-full/__object__` */
  async function fixtureRoot() {
    const rootPath = path.join(temp.dir, `fixture-${count++}`);
    await writeSpecExFullRoot(rootPath);
    return openStorageRoot(rootPath);
  }

  it('reports no problems for an intact object, and how many stored files it checked', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'intact', { 'a.txt': 'abc', 'b.txt': 'b', 'c.txt': 'c' });
    assert.deepStrictEqual(await object.checkFixity(), { problems: [], checkedFiles: 3 });
  });

  it('counts each stored file of a digest the manifest stores at more than one content path', async () => {
    const root = await fixtureRoot();
    const objectRoot = path.join(root.path, 'spec-ex-full', '__object__');
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest![sha512('')]!.push('v1/content/empty-copy.txt');
    });
    await writeFiles(objectRoot, { 'v1/content/empty-copy.txt': '' });
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(await object.checkFixity(), { problems: [], checkedFiles: 5 });
  });

  it('names a stored file by its path from the storage root, with / between directories', async () => {
    const root = await fixtureRoot();
    await fs.promises.rm(path.join(root.path, 'spec-ex-full', '__object__', 'v1', 'content', 'image.tiff'));
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(
      (await object.checkFixity()).problems.map(({ storedFile }) => storedFile),
      ['spec-ex-full/__object__/v1/content/image.tiff'],
    );
  });

  it('lists every version and logical path a stored file backs, by version then path', async () => {
    const root = await fixtureRoot();
    await fs.promises.rm(path.join(root.path, 'spec-ex-full', '__object__', 'v1', 'content', 'empty.txt'));
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(
      (await object.checkFixity()).problems.map(({ affects }) => affects),
      [
        [
          { version: 1, path: 'empty.txt' },
          { version: 2, path: 'empty.txt' },
          { version: 2, path: 'empty2.txt' },
          { version: 3, path: 'empty2.txt' },
        ],
      ],
    );
  });

  it('checks and lists only the logical paths that read each stored file, when the manifest stores its digest at more than one', async () => {
    const root = await fixtureRoot();
    const objectRoot = path.join(root.path, 'spec-ex-full', '__object__');
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest![sha512('')]!.push('v1/content/empty-copy.txt');
    });
    await fs.promises.rm(path.join(objectRoot, 'v1', 'content', 'empty.txt'));
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual(await object.checkFixity(), {
      problems: [
        { kind: 'missing', storedFile: 'spec-ex-full/__object__/v1/content/empty-copy.txt', affects: [], expected: sha512('') },
        {
          kind: 'missing',
          storedFile: 'spec-ex-full/__object__/v1/content/empty.txt',
          affects: [
            { version: 1, path: 'empty.txt' },
            { version: 2, path: 'empty.txt' },
            { version: 2, path: 'empty2.txt' },
            { version: 3, path: 'empty2.txt' },
          ],
          expected: sha512(''),
        },
      ],
      checkedFiles: 5,
    });
  });

  it('names a stored file from the storage root under a layout that nests object roots in hashed directories', async () => {
    const root = await temp.newRoot({ extensionName: '0004-hashed-n-tuple-storage-layout' });
    const object = await createObject(root, 'object-01', { 'a.txt': 'abc', 'b.txt': 'b' });
    const objectPath = '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4';
    await fs.promises.writeFile(path.join(root.path, objectPath, 'v1/content/a.txt'), 'abd');
    await fs.promises.rm(path.join(root.path, objectPath, 'v1/content/b.txt'));
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: `${objectPath}/v1/content/a.txt`,
        affects: [{ version: 1, path: 'a.txt' }],
        expected: DIGESTS_OF_ABC.sha512,
        actual: sha512('abd'),
      },
      { kind: 'missing', storedFile: `${objectPath}/v1/content/b.txt`, affects: [{ version: 1, path: 'b.txt' }], expected: sha512('b') },
    ]);
  });

  it('reports a stored file whose content has changed, with the digest recorded and the digest found', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'changed', { 'a.txt': 'abc', 'b.txt': 'intact' });
    await fs.promises.writeFile(path.join(objectRootOf(root, 'changed'), 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: 'changed/v1/content/a.txt',
        affects: [{ version: 1, path: 'a.txt' }],
        expected: DIGESTS_OF_ABC.sha512,
        actual: sha512('abd'),
      },
    ]);
  });

  it('reports a stored file that is gone as missing, with no digest found', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'missing', { 'a.txt': 'abc', 'b.txt': 'intact' });
    await fs.promises.rm(path.join(objectRootOf(root, 'missing'), 'v1/content/a.txt'));
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      { kind: 'missing', storedFile: 'missing/v1/content/a.txt', affects: [{ version: 1, path: 'a.txt' }], expected: DIGESTS_OF_ABC.sha512 },
    ]);
  });

  it('reports a stored file that is not a regular file as missing, and checks the rest', async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'directory', { 'a.txt': 'abc', 'b.txt': 'b' });
    const objectRoot = objectRootOf(root, 'directory');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/a.txt'));
    await fs.promises.mkdir(path.join(objectRoot, 'v1/content/a.txt'));
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/b.txt'), 'c');
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      { kind: 'missing', storedFile: 'directory/v1/content/a.txt', affects: [{ version: 1, path: 'a.txt' }], expected: DIGESTS_OF_ABC.sha512 },
      { kind: 'changed', storedFile: 'directory/v1/content/b.txt', affects: [{ version: 1, path: 'b.txt' }], expected: sha512('b'), actual: sha512('c') },
    ]);
  });

  it('reports a stored file that is a named pipe as missing, without waiting for a writer', { timeout: 5000 }, async () => {
    const root = await temp.newRoot();
    const object = await createObject(root, 'fifo', { 'a.txt': 'abc' });
    const stored = path.join(objectRootOf(root, 'fifo'), 'v1/content/a.txt');
    await fs.promises.rm(stored);
    execFileSync('mkfifo', [stored]);
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      { kind: 'missing', storedFile: 'fifo/v1/content/a.txt', affects: [{ version: 1, path: 'a.txt' }], expected: DIGESTS_OF_ABC.sha512 },
    ]);
  });

  it('reports every problem in the object, not just the first', async () => {
    const root = await temp.newRoot();
    let object = await createObject(root, 'several', { 'a.txt': 'abc', 'b.txt': 'b', 'c.txt': 'intact' });
    object = await object.update(DETAILS, (draft) => draft.write('d.txt', 'd'));
    const objectRoot = objectRootOf(root, 'several');
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    await fs.promises.rm(path.join(objectRoot, 'v1/content/b.txt'));
    await fs.promises.writeFile(path.join(objectRoot, 'v2/content/d.txt'), 'e');
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: 'several/v1/content/a.txt',
        affects: [
          { version: 1, path: 'a.txt' },
          { version: 2, path: 'a.txt' },
        ],
        expected: DIGESTS_OF_ABC.sha512,
        actual: sha512('abd'),
      },
      {
        kind: 'missing',
        storedFile: 'several/v1/content/b.txt',
        affects: [
          { version: 1, path: 'b.txt' },
          { version: 2, path: 'b.txt' },
        ],
        expected: sha512('b'),
      },
      { kind: 'changed', storedFile: 'several/v2/content/d.txt', affects: [{ version: 2, path: 'd.txt' }], expected: sha512('d'), actual: sha512('e') },
    ]);
  });

  it('reports a stored file once, with every version and logical path it backs', async () => {
    const root = await temp.newRoot();
    let object = await createObject(root, 'shared', { 'a.txt': 'abc', 'copy.txt': 'abc' });
    object = await object.update(DETAILS, (draft) => draft.write('later.txt', 'abc'));
    assert.strictEqual(object.versions.size, 2);
    await fs.promises.writeFile(path.join(objectRootOf(root, 'shared'), 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: 'shared/v1/content/a.txt',
        affects: [
          { version: 1, path: 'a.txt' },
          { version: 1, path: 'copy.txt' },
          { version: 2, path: 'a.txt' },
          { version: 2, path: 'copy.txt' },
          { version: 2, path: 'later.txt' },
        ],
        expected: DIGESTS_OF_ABC.sha512,
        actual: sha512('abd'),
      },
    ]);
  });

  it('ignores files on disk that are not in the manifest', async () => {
    const root = await fixtureRoot();
    await writeFiles(path.join(root.path, 'spec-ex-full', '__object__'), { 'v1/content/extra.txt': 'extra', 'extra.txt': 'extra' });
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual((await object.checkFixity()).problems, []);
  });

  it('ignores the fixity block, even when a value in it is wrong', async () => {
    const root = await fixtureRoot();
    await rewriteInventory(path.join(root.path, 'spec-ex-full', '__object__'), (inventory) => {
      inventory.fixity = { md5: { [DIGESTS_OF_ABC.md5]: ['v1/content/foo/bar.xml'] } };
    });
    const object = await root.open(SPEC_EX_FULL_ID);
    assert.deepStrictEqual((await object.checkFixity()).problems, []);
  });

  it('checks a sha256 object with sha256', async () => {
    const root = await temp.newRoot();
    const objectRoot = objectRootOf(root, 'sha256-object');
    await writeForeignObject(objectRoot, 'sha256-object', { 'a.txt': 'abc' }, { digestAlgorithm: 'sha256' });
    const object = await root.open('sha256-object');
    assert.deepStrictEqual((await object.checkFixity()).problems, []);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: 'sha256-object/v1/content/a.txt',
        affects: [{ version: 1, path: 'a.txt' }],
        expected: DIGESTS_OF_ABC.sha256,
        actual: createHash('sha256').update('abd').digest('hex'),
      },
    ]);
  });

  it('matches digests the inventory records in upper case, and reports them in lower case', async () => {
    const root = await temp.newRoot();
    await createObject(root, 'upper-case', { 'a.txt': 'abc', 'b.txt': 'b' });
    const objectRoot = objectRootOf(root, 'upper-case');
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest = upperCased(inventory.manifest!);
      inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
    });
    const object = await root.open('upper-case');
    const changedA = {
      kind: 'changed',
      storedFile: 'upper-case/v1/content/a.txt',
      affects: [{ version: 1, path: 'a.txt' }],
      expected: DIGESTS_OF_ABC.sha512,
      actual: sha512('abd'),
    };
    assert.deepStrictEqual((await object.checkFixity()).problems, []);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual((await object.checkFixity()).problems, [changedA]);
    await fs.promises.rm(path.join(objectRoot, 'v1/content/b.txt'));
    assert.deepStrictEqual((await object.checkFixity()).problems, [
      changedA,
      { kind: 'missing', storedFile: 'upper-case/v1/content/b.txt', affects: [{ version: 1, path: 'b.txt' }], expected: sha512('b') },
    ]);
  });

  it('checks only the versions the object knew about when it was opened', async () => {
    const root = await temp.newRoot();
    const opened = await createObject(root, 'earlier', { 'a.txt': 'abc' });
    const updated = await opened.update(DETAILS, (draft) => draft.write('later.txt', 'later'));
    const objectRoot = objectRootOf(root, 'earlier');
    await fs.promises.rm(path.join(objectRoot, 'v2/content/later.txt'));
    assert.deepStrictEqual((await opened.checkFixity()).problems, []);
    assert.deepStrictEqual((await updated.checkFixity()).problems, [
      { kind: 'missing', storedFile: 'earlier/v2/content/later.txt', affects: [{ version: 2, path: 'later.txt' }], expected: sha512('later') },
    ]);
    await fs.promises.writeFile(path.join(objectRoot, 'v1/content/a.txt'), 'abd');
    assert.deepStrictEqual((await opened.checkFixity()).problems, [
      {
        kind: 'changed',
        storedFile: 'earlier/v1/content/a.txt',
        affects: [{ version: 1, path: 'a.txt' }],
        expected: DIGESTS_OF_ABC.sha512,
        actual: sha512('abd'),
      },
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
    const { problems } = await object.checkFixity();
    assert.deepStrictEqual(
      problems.map(({ kind, storedFile }) => [kind, storedFile]),
      [
        ['missing', 'many/v1/content/file-07.txt'],
        ['missing', 'many/v1/content/file-33.txt'],
      ],
    );
  });
});
