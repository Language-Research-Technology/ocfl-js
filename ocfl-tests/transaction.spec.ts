import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { OcflObject, OcflObjectTransaction } from '@ocfl/ocfl';
import type { Ocfl } from './index.ts';

const sha512 = (text: string) => createHash('sha512').update(text).digest('hex');

export default (ocfl: Ocfl) => {
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
      workspace = path.join(tempdir, 'workspace');
      source = path.join(tempdir, 'source');
      await fs.promises.mkdir(path.join(source, 'data', 'a', 'aa'), { recursive: true });
      await fs.promises.mkdir(path.join(source, 'data', 'b'), { recursive: true });
      await fs.promises.writeFile(path.join(source, 'metadata.json'), '{}');
      await fs.promises.writeFile(path.join(source, 'data', 'a', 'a.txt'), 'data a');
      await fs.promises.writeFile(path.join(source, 'data', 'b', 'b.txt'), 'data b');
      await fs.promises.writeFile(path.join(source, 'data', 'a', 'aa', 'aa.txt'), 'data aa');
      object = ocfl.object({ id: 'test', root, workspace });
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

    it('createWritable', async () => {
      const trx = await begin();
      const writer = (await trx.createWritable('test.txt')).getWriter();
      await writer.write('test1');
      await writer.write('test2');
      await writer.close();
      assert.strictEqual(read(path.join(workspace, 'v1/content/test.txt')), 'test1test2');
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

    it('write with fixity', async () => {
      const withFixity = ocfl.object({ id: 'test', root, workspace, fixityAlgorithms: ['size', 'crc32'] });
      const trx = (await withFixity.update()) as OcflObjectTransaction;
      await trx.write('test.txt', 'Hello, World!');
      await trx.commit();
      const { fixity } = withFixity.inventory!;
      assert(fixity!.size!['13']!.includes('v1/content/test.txt'));
      assert(fixity!.crc32!.ec4ac3d0!.includes('v1/content/test.txt'));
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
      await trx.import(source, '');
      await trx.copy('data/a/a.txt', 'data/c/c.txt');
      await trx.commit();
      assert.strictEqual(object.inventory!.getDigest('data/c/c.txt'), sha512('data a'));
      assert.strictEqual(object.inventory!.getDigest('data/a/a.txt'), sha512('data a'));
    });

    it('rename', async () => {
      const trx = await begin();
      await trx.import(source, '');
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
      await trx.import(source, '');
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
      await trx.import(source, '');
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
};
