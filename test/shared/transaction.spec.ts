import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { OcflObjectTransaction } from '../../src/index.ts';
import type { OcflObject } from '../../src/object.ts';
import { testObject } from '../test-object.ts';

const sha512 = (text: string) => createHash('sha512').update(text).digest('hex');

describe('transaction from update() with no callback', () => {
  let tempdir: string;
  let root: string;
  let workspace: string;
  let source: string;
  let object: OcflObject;

  const read = (file: string) => fs.readFileSync(file, 'utf-8');
  const begin = async () => (await object.update()) as OcflObjectTransaction;

  beforeEach(async () => {
    tempdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-tests-transaction-'));
    root = path.join(tempdir, 'ocfl', 'test');
    source = path.join(tempdir, 'source');
    await fs.promises.mkdir(path.join(source, 'data', 'a', 'aa'), { recursive: true });
    await fs.promises.mkdir(path.join(source, 'data', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(source, 'metadata.json'), '{}');
    await fs.promises.writeFile(path.join(source, 'data', 'a', 'a.txt'), 'data a');
    await fs.promises.writeFile(path.join(source, 'data', 'b', 'b.txt'), 'data b');
    await fs.promises.writeFile(path.join(source, 'data', 'a', 'aa', 'aa.txt'), 'data aa');
    object = testObject({ id: 'test', root });
    workspace = object._workspace;
  });

  afterEach(async () => {
    await fs.promises.rm(tempdir, { recursive: true, force: true });
  });

  it('creates the workspace', async () => {
    const trx = await begin();
    assert(fs.existsSync(workspace));
    await trx.commit();
  });

  it('rollback', async () => {
    const trx = await begin();
    await trx.write('test.txt', 'test');
    assert.strictEqual(read(path.join(workspace, 'v1/content/test.txt')), 'test');
    await trx.rollback();
    assert(!fs.existsSync(path.join(root, 'v1/content/test.txt')));
  });

  it('commit', async () => {
    const trx = await begin();
    await trx.write('test.txt', 'test');
    assert.strictEqual(read(path.join(workspace, 'v1/content/test.txt')), 'test');
    await trx.commit({ message: 'test commit', user: { name: 'tester', address: 'tester@example.com' } });
    assert(fs.existsSync(path.join(root, 'v1/content/test.txt')));
    const version = object.inventory!.versions.v1!;
    assert.strictEqual(version.message, 'test commit');
    assert.strictEqual(version.user!.name, 'tester');
    assert.strictEqual(version.user!.address, 'tester@example.com');
    await trx.commit();
  });

  it('write', async () => {
    const trx = await begin();
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const streamed = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    await trx.write('test.txt', 'Hello, World!');
    await trx.write('test/test.txt', 'Test content');
    await trx.write('test.bin', bytes);
    await trx.write(
      'stream.bin',
      new ReadableStream({
        start(controller) {
          controller.enqueue(streamed);
          controller.close();
        },
      }),
    );
    const content = path.join(workspace, 'v1/content');
    assert.strictEqual(read(path.join(content, 'test.txt')), 'Hello, World!');
    assert.strictEqual(read(path.join(content, 'test/test.txt')), 'Test content');
    assert.deepStrictEqual(new Uint8Array(fs.readFileSync(path.join(content, 'test.bin'))), bytes);
    assert.deepStrictEqual(new Uint8Array(fs.readFileSync(path.join(content, 'stream.bin'))), streamed);
    await trx.commit();
  });

  it('write stores only the bytes a partial view covers', async () => {
    const trx = await begin();
    const bytes = new TextEncoder().encode('HELLOworld');
    await trx.write('view.bin', new DataView(bytes.buffer, 5, 5));
    assert.strictEqual(read(path.join(workspace, 'v1/content/view.bin')), 'world');
    await trx.commit();
  });

  it('records created, message and user on a later version, leaving earlier versions as they were', async () => {
    let trx = await begin();
    await trx.write('a.txt', 'first');
    await trx.commit({ message: 'one', user: { name: 'ann' } });
    const v1 = object.inventory!.toJSON().versions.v1;
    const started = Date.now();
    trx = await begin();
    await trx.write('b.txt', 'second!');
    await trx.commit({ message: 'two', user: { name: 'bob', address: 'mailto:bob@example.com' } });

    const inventory = (await testObject({ root }).getInventory())!;
    assert.strictEqual(inventory.head, 'v2');
    assert.strictEqual(inventory.message, 'two');
    assert.deepStrictEqual(inventory.user, { name: 'bob', address: 'mailto:bob@example.com' });
    assert.ok(Date.parse(inventory.created) >= started - 1000);
    assert.deepStrictEqual(inventory.toJSON().versions.v1, v1);
  });

  it('rolls back a commit with no changes, keeping the current version', async () => {
    let trx = await begin();
    await trx.write('a.txt', 'same');
    await trx.commit();
    trx = await begin();
    await trx.write('a.txt', 'same');
    await trx.commit();
    assert.strictEqual(object.inventory!.head, 'v1');
    assert.strictEqual((await testObject({ root }).getInventory())!.head, 'v1');
    assert(!fs.existsSync(path.join(root, 'v2')));
    assert(!fs.existsSync(path.join(workspace, 'v2')));
  });

  it('reads every version and reports what changed between them', async () => {
    let trx = await begin();
    await trx.write('a.txt', 'one');
    await trx.write('b.txt', 'two');
    await trx.commit();
    trx = await begin();
    await trx.write('a.txt', 'changed');
    await trx.write('c.txt', 'three');
    await trx.remove('b.txt');
    await trx.commit();

    const reader = testObject({ root });
    await reader.load();
    const inventory = reader.inventory!;
    assert.deepStrictEqual(Object.keys(inventory.versions), ['v1', 'v2']);
    assert.strictEqual(await reader.getFile('a.txt', 'v1')!.text(), 'one');
    assert.strictEqual(await reader.getFile('a.txt', 'v2')!.text(), 'changed');
    assert.strictEqual(inventory.getDigest('b.txt', 'v1'), sha512('two'));
    assert.strictEqual(inventory.getDigest('b.txt', 'v2'), undefined);
    assert.deepStrictEqual([...inventory.files('v1')].map((f) => f.logicalPath).sort(), ['a.txt', 'b.txt']);
    assert.deepStrictEqual([...inventory.files('v2')].map((f) => f.logicalPath).sort(), ['a.txt', 'c.txt']);
    assert.deepStrictEqual(inventory.diffState('v2', 'v1'), [
      { [sha512('changed')]: ['a.txt'], [sha512('three')]: ['c.txt'] },
      { [sha512('one')]: ['a.txt'], [sha512('two')]: ['b.txt'] },
    ]);
  });

  it('caches a committed inventory that offers only reading operations', async () => {
    const trx = await begin();
    await trx.write('a.txt', 'a');
    await trx.commit();
    for (const member of ['add', 'rename', 'copy', 'delete', 'reinstate', 'addFixity', 'isChanged', 'clone']) {
      assert(!(member in object.inventory!), `${member} is on the committed inventory`);
    }
  });

  it('import', async () => {
    const trx = await begin();
    await trx.import(path.join(source, 'metadata.json'), 'metadata.json');
    await trx.import(path.join(source, 'data'), 'data');
    const content = path.join(workspace, 'v1/content');
    assert.strictEqual(read(path.join(content, 'metadata.json')), '{}');
    assert.strictEqual(read(path.join(content, 'data/a/a.txt')), 'data a');
    assert.strictEqual(read(path.join(content, 'data/b/b.txt')), 'data b');
    assert.strictEqual(read(path.join(content, 'data/a/aa/aa.txt')), 'data aa');
    await trx.commit();
  });

  it('copy', async () => {
    const trx = await begin();
    await trx.import(source);
    await trx.copy('data/a/a.txt', 'data/c/c.txt');
    await trx.commit();
    assert.strictEqual(object.inventory!.getDigest('data/c/c.txt'), sha512('data a'));
    assert.strictEqual(object.inventory!.getDigest('data/a/a.txt'), sha512('data a'));
  });

  it('rename', async () => {
    const trx = await begin();
    await trx.import(source);
    await trx.rename('data/a/a.txt', 'data/c/c.txt');
    const content = path.join(workspace, 'v1/content');
    assert(fs.existsSync(path.join(content, 'data/c/c.txt')));
    assert(!fs.existsSync(path.join(content, 'data/a/a.txt')));
    await trx.commit();
    assert.strictEqual(object.inventory!.getDigest('data/c/c.txt'), sha512('data a'));
    assert(!object.inventory!.getDigest('data/a/a.txt'));
  });

  it('remove', async () => {
    let trx = await begin();
    await trx.import(source);
    assert.strictEqual(read(path.join(workspace, 'v1/content/data/a/a.txt')), 'data a');
    await trx.remove('data/a/a.txt');
    assert(!fs.existsSync(path.join(workspace, 'v1/content/data/a/a.txt')));
    await trx.commit();
    trx = await begin();
    assert(object.inventory!.getDigest('data/b/b.txt'));
    await trx.remove('data/b/b.txt');
    await trx.commit();
    assert(!object.inventory!.getDigest('data/b/b.txt'));
  });

  it('reinstate', async () => {
    let trx = await begin();
    await trx.import(source);
    await trx.commit();
    assert(object.inventory!.getDigest('metadata.json'));
    trx = await begin();
    await trx.remove('metadata.json');
    await trx.commit();
    assert(!object.inventory!.getDigest('metadata.json'));
    trx = await begin();
    await trx.reinstate('metadata.json', 'v1');
    await trx.commit();
    assert(object.inventory!.getDigest('metadata.json'));
  });
});
