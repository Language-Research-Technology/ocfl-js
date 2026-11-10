import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import ocfl, { type OcflObject } from '../src/index.ts';

const CONCURRENCY_LIMIT = 10;

async function makeTree(dir: string, depth: number, width: number) {
  for (let i = 0; i < width; i++) {
    if (depth === 1) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, `f${i}.txt`), `${dir}/f${i}`);
    } else {
      await makeTree(path.join(dir, `d${i}`), depth - 1, width);
    }
  }
}

const logicalPaths = async (o: OcflObject) => [...(await o.files())].map((f) => f.logicalPath).sort();

describe('import', () => {
  let tempdir: string;
  let source: string;
  let object: OcflObject;

  beforeEach(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-import-'));
    source = path.join(tempdir, 'source');
    await fs.promises.mkdir(source);
    object = ocfl.object({ id: 'test', root: path.join(tempdir, 'object') });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('keeps open files within one concurrency limit however deep the tree is', async () => {
    await makeTree(source, 3, 4);
    const createReadStream = fs.createReadStream;
    let open = 0;
    let maxOpen = 0;
    mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
      const stream = createReadStream(...args);
      maxOpen = Math.max(maxOpen, ++open);
      stream.once('close', () => open--);
      return stream;
    });
    await object.import(source);
    assert.strictEqual(await object.count(), 64);
    assert(maxOpen <= CONCURRENCY_LIMIT, `${maxOpen} files were open at once`);
  });

  it('keeps reads and copies within the limit across concurrent imports in one transaction', async () => {
    const second = path.join(tempdir, 'second');
    await makeTree(source, 2, 8);
    await makeTree(second, 2, 8);
    const createReadStream = fs.createReadStream;
    const copyFile = fs.promises.copyFile;
    let open = 0;
    let maxOpen = 0;
    mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
      const stream = createReadStream(...args);
      maxOpen = Math.max(maxOpen, ++open);
      stream.once('close', () => open--);
      return stream;
    });
    mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
      maxOpen = Math.max(maxOpen, ++open);
      try {
        return await copyFile(from, to);
      } finally {
        open--;
      }
    });
    await object.update(async (t) => {
      await Promise.all([t.import(source, 'a'), t.import(second, 'b')]);
    });
    assert.strictEqual(await object.count(), 128);
    assert(maxOpen <= CONCURRENCY_LIMIT, `${maxOpen} files were open at once`);
  });

  it('rejects a directory containing a symlink and creates no version', async () => {
    await fs.promises.writeFile(path.join(source, 'a.txt'), 'a');
    await fs.promises.symlink(path.join(source, 'a.txt'), path.join(source, 'link.txt'));
    await assert.rejects(object.import(source), { code: 'UNSUPPORTED_FILE_TYPE' });
    assert.strictEqual(await object.exists(), false);
  });

  it('rejects a source that is itself a symlink', async () => {
    const link = path.join(tempdir, 'link');
    await fs.promises.symlink(source, link);
    await assert.rejects(object.import(link), { code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('fails with SOURCE_CHANGED when a source changes between hashing and copying', async () => {
    const file = path.join(source, 'a.txt');
    await fs.promises.writeFile(file, 'v1');
    await object.import(source);
    await fs.promises.writeFile(file, 'hashed');
    const copyFile = fs.promises.copyFile;
    mock.method(fs.promises, 'copyFile', async (from: string, to: string) => {
      await fs.promises.writeFile(file, 'changed before the copy');
      return copyFile(from, to);
    });
    await assert.rejects(object.import(source), (e) => {
      assert.ok(e instanceof AggregateError);
      assert.deepStrictEqual(
        e.errors.map((error: { code?: string }) => error.code),
        ['SOURCE_CHANGED'],
      );
      return true;
    });
    await object.refresh();
    assert.strictEqual(object.headVersion?.toString(), 'v1');
    assert.strictEqual(fs.existsSync(path.join(object.root, 'v2')), false);
    const stored = await fs.promises.readFile(path.join(object.root, 'v1/content/a.txt'));
    assert.strictEqual(createHash('sha512').update(stored).digest('hex'), object.inventory?.getDigest('a.txt'));
  });

  it('copies nothing for content the object already holds', async () => {
    await fs.promises.writeFile(path.join(source, 'a.txt'), 'same');
    await object.import(source);
    await fs.promises.writeFile(path.join(source, 'b.txt'), 'same');
    const copies = mock.method(fs.promises, 'copyFile');
    await object.import(source);
    const fromSource = copies.mock.calls.filter((call) => String(call.arguments[0]).startsWith(source));
    assert.strictEqual(fromSource.length, 0);
    assert.strictEqual(await object.getFile('b.txt')?.text(), 'same');
  });

  describe('target', () => {
    beforeEach(async () => {
      await fs.promises.mkdir(path.join(source, 'sub'));
      await fs.promises.writeFile(path.join(source, 'a.txt'), 'a');
      await fs.promises.writeFile(path.join(source, 'sub', 'b.txt'), 'b');
    });

    it("puts a directory's contents at the root when omitted, from either entry point", async () => {
      const other = ocfl.object({ id: 'other', root: path.join(tempdir, 'other') });
      await object.import(source);
      await other.update(async (t) => t.import(source));
      assert.deepStrictEqual(await logicalPaths(object), ['a.txt', 'sub/b.txt']);
      assert.deepStrictEqual(await logicalPaths(other), ['a.txt', 'sub/b.txt']);
    });

    it("puts a directory's contents under the target", async () => {
      await object.update(async (t) => t.import(source, 'x'));
      assert.deepStrictEqual(await logicalPaths(object), ['x/a.txt', 'x/sub/b.txt']);
    });

    it('keeps a file at its own name when omitted', async () => {
      await object.update(async (t) => t.import(path.join(source, 'sub', 'b.txt')));
      assert.deepStrictEqual(await logicalPaths(object), ['b.txt']);
    });

    it('rejects an empty target, for a directory as for a file', async () => {
      for (const target of ['', '.', './']) {
        await assert.rejects(object.import(source, target), { code: 'INVALID_LOGICAL_PATH' });
        await assert.rejects(object.import(path.join(source, 'a.txt'), target), { code: 'INVALID_LOGICAL_PATH' });
      }
    });

    it('normalises a target the way copy() and rename() do', async () => {
      await object.update(async (t) => {
        await t.import(path.join(source, 'a.txt'), './docs//a.txt');
        await t.import(path.join(source, 'sub'), 'more/');
      });
      assert.deepStrictEqual(await logicalPaths(object), ['docs/a.txt', 'more/b.txt']);
    });
  });

  describe('OcflObject.import options', () => {
    const user = { name: 'importer', address: 'https://example.org/importer' };

    beforeEach(async () => {
      await fs.promises.writeFile(path.join(source, 'a.txt'), 'a');
    });

    it('records the message and user of a single source without a target', async () => {
      await object.import(source, { message: 'Nightly sync', user });
      assert.strictEqual(object.inventory?.version.message, 'Nightly sync');
      assert.deepStrictEqual(object.inventory?.version.user, user);
    });

    it('takes a target, a mode and provenance for a single source', async () => {
      await object.import(source);
      await object.import(source, 'x', { mode: 'REPLACE', message: 'Move under x', user });
      assert.deepStrictEqual(await logicalPaths(object), ['x/a.txt']);
      assert.strictEqual(object.inventory?.version.message, 'Move under x');
      assert.deepStrictEqual(object.inventory?.version.user, user);
    });

    it('throws FILE_EXISTS when one source imports a file where another imports a directory', async () => {
      await fs.promises.mkdir(path.join(source, 'sub'));
      await fs.promises.writeFile(path.join(source, 'sub', 'b.txt'), 'b');
      const file = path.join(tempdir, 'sub.txt');
      await fs.promises.writeFile(file, 'not a directory');
      await assert.rejects(object.import([{ source }, { source: file, target: 'sub' }]), { code: 'FILE_EXISTS' });
      assert.strictEqual(await object.exists(), false);
    });

    it('catches two spellings of the same logical path', async () => {
      const other = path.join(tempdir, 'other.txt');
      await fs.promises.writeFile(other, 'other');
      await assert.rejects(object.import([{ source }, { source: other, target: './a.txt' }]), { code: 'FILE_EXISTS' });
    });

    it('imports several named sources as one version', async () => {
      const other = path.join(tempdir, 'other.txt');
      await fs.promises.writeFile(other, 'other');
      await object.import([{ source }, { source: other, target: 'docs/other.txt' }], { message: 'Deposit', user });
      assert.deepStrictEqual(await logicalPaths(object), ['a.txt', 'docs/other.txt']);
      assert.strictEqual(object.inventory?.version.message, 'Deposit');
      assert.strictEqual(object.headVersion?.toString(), 'v1');
    });

    it('throws FILE_EXISTS when two sources produce the same logical path, and creates no version', async () => {
      const second = path.join(tempdir, 'second');
      await fs.promises.mkdir(second);
      await fs.promises.writeFile(path.join(second, 'a.txt'), 'other a');
      await assert.rejects(object.import([{ source }, { source: second }]), { code: 'FILE_EXISTS' });
      assert.strictEqual(await object.exists(), false);
    });

    it('updates a path the previous version already has, without a conflict', async () => {
      await object.import(source);
      await fs.promises.writeFile(path.join(source, 'a.txt'), 'new a');
      await object.import(source);
      assert.strictEqual(await object.getFile('a.txt')?.text(), 'new a');
    });
  });

  describe('OcflObject.update options', () => {
    it('records the message and user', async () => {
      const user = { name: 'updater' };
      await object.update(async (t) => t.write('a.txt', 'a'), { message: 'Add a', user });
      assert.strictEqual(object.inventory?.version.message, 'Add a');
      assert.deepStrictEqual(object.inventory?.version.user, user);
    });

    it('throws a TypeError for options that are not an object, such as a 0.4 positional mode', async () => {
      await assert.rejects(
        // @ts-expect-error the 0.4 signature
        object.update(async (t) => t.write('a.txt', 'a'), 'REPLACE'),
        TypeError,
      );
      // @ts-expect-error deliberately invalid
      await assert.rejects(object.import(source, null), TypeError);
      assert.strictEqual(await object.exists(), false);
    });

    it('throws a TypeError when given provenance but no updater', async () => {
      await assert.rejects(object.update(undefined, { message: 'lost' }), TypeError);
      await assert.rejects(object.update(undefined, { user: { name: 'lost' } }), TypeError);
      assert.strictEqual(await object.exists(), false);
    });
  });
});
