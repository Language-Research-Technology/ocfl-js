import assert from 'node:assert';
import { createFsFromVolume, Volume } from 'memfs';
import { OcflFsStore } from '../../ocfl-fs/src/store.ts';
import { OcflDigest } from '../src/digest.ts';
import { OcflObjectInventory } from '../src/inventory.ts';
import { OcflObjectTransactionImpl } from '../src/transaction.ts';

/** In-memory store for testing */
const volInit = {
  '/ocfl/test': {},
  '/source/metadata.json': '{}',
  '/source/data/a/a.txt': 'data a',
  '/source/data/b/b.txt': 'data b',
  '/source/data/a/aa/aa.txt': 'data aa',
};

describe('OcflTransactionImpl class', () => {
  /** @type {import('memfs').IFs} */
  let fs;
  /** @type {string} */
  const root = '/ocfl/test';
  let newInv = null;
  let store;
  const object = {
    root,
    _setInventory: (inv) => {
      newInv = inv;
    },
    async _ensureNamaste() {},
  };

  beforeEach(async () => {
    fs = createFsFromVolume(Volume.fromJSON(volInit));
    store = OcflFsStore.getInstance({ fs });
    newInv = null;
  });

  async function createTransaction(inv) {
    newInv = OcflObjectInventory.newVersion(
      inv || {
        id: 'test',
        digestAlgorithm: 'sha512',
        type: `https://ocfl.io/v1.1/spec/#inventory`,
      },
    );
    return OcflObjectTransactionImpl.create(object, store, newInv, '/workspace');
  }

  it('creates the temp dir', async () => {
    const trx = await createTransaction();
    assert(fs.existsSync('/workspace'));
    await trx.commit();
  });

  it('rollback', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    await trx.write('test.txt', 'test');
    assert.strictEqual(fs.readFileSync(`${wp}/content/test.txt`, 'utf-8'), 'test');
    await trx.rollback();
    assert(!fs.existsSync(`${root}/v1/content/test.txt`));
  });

  it('commit', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    await trx.write('test.txt', 'test');
    assert.strictEqual(fs.readFileSync(`${wp}/content/test.txt`, 'utf-8'), 'test');
    await trx.commit({ message: 'test commit', user: { name: 'tester', address: 'tester@example.com' } });
    assert(fs.existsSync(`${root}/v1/content/test.txt`));
    // test for optional information
    assert.strictEqual(newInv.versions.v1.message, 'test commit');
    assert.strictEqual(newInv.versions.v1.user.name, 'tester');
    assert.strictEqual(newInv.versions.v1.user.address, 'tester@example.com');
    await trx.commit();
  });

  it('createWritable', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    const ws = await trx.createWritable('test.txt');
    const writer = ws.getWriter();
    await writer.write('test1');
    await writer.write('test2');
    await writer.close();
    assert.strictEqual(fs.readFileSync(`${wp}/content/test.txt`, 'utf-8'), 'test1test2');
    await trx.commit();
  });

  it('write', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    // test writing text
    const text1 = 'Hello, World!';
    const text2 = 'Test content';
    await trx.write('test.txt', text1);
    await trx.write('test/test.txt', text2);
    // test writing bytes
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const bytes2 = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    await trx.write('test.bin', bytes);
    // test writing stream
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes2);
        controller.close();
      },
    });
    await trx.write('stream.bin', rs);
    // verify contents
    const decoder = new TextDecoder();
    assert.strictEqual(fs.readFileSync(`${wp}/content/test.txt`, 'utf-8'), text1);
    assert.strictEqual(fs.readFileSync(`${wp}/content/test/test.txt`, 'utf-8'), text2);
    assert.strictEqual(fs.readFileSync(`${wp}/content/test.bin`, 'utf-8'), decoder.decode(bytes));
    assert.strictEqual(fs.readFileSync(`${wp}/content/stream.bin`, 'utf-8'), decoder.decode(bytes2));
    await trx.commit();
  });

  it('write with fixity', async () => {
    object.fixityAlgorithms = ['size', 'crc32'];
    const trx = await createTransaction();
    const text = 'Hello, World!';
    await trx.write('test.txt', text);
    await trx.commit();
    const { size, crc32 } = await OcflDigest.digest(['size', 'crc32'], text);
    assert(newInv.fixity.size[size].includes('v1/content/test.txt'));
    assert(newInv.fixity.crc32[crc32].includes('v1/content/test.txt'));
  });

  it('import', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    // import a file
    await trx.import('/source/metadata.json', 'metadata.json');
    assert.strictEqual(fs.readFileSync(`${wp}/content/metadata.json`, 'utf-8'), '{}');
    // import a directory
    await trx.import('/source/data', 'data');
    assert.strictEqual(fs.readFileSync(`${wp}/content/data/a/a.txt`, 'utf-8'), 'data a');
    assert.strictEqual(fs.readFileSync(`${wp}/content/data/b/b.txt`, 'utf-8'), 'data b');
    assert.strictEqual(fs.readFileSync(`${wp}/content/data/a/aa/aa.txt`, 'utf-8'), 'data aa');
    await trx.commit();
  });

  it('purge', async () => {
    let trx = await createTransaction();
    // create two versions
    await trx.write('test.txt', 'test');
    await trx.commit();
    trx = await createTransaction(newInv);
    await trx.write('test.txt', 'test2');
    await trx.commit();
    assert(fs.existsSync(`${root}/v1/content/test.txt`));
    assert(fs.existsSync(`${root}/v2/content/test.txt`));
    trx = await createTransaction(newInv);
    assert(newInv.getDigest('test.txt', 'v1'));
    assert(newInv.getDigest('test.txt', 'v2'));
    await trx.purge('test.txt');
    await trx.commit({ force: true });
    assert(fs.existsSync(`${root}/v1/content/test.txt`));
    assert(fs.existsSync(`${root}/v2/content/test.txt`));
    assert(!newInv.getDigest('test.txt', 'v1'));
    assert(!newInv.getDigest('test.txt', 'v2'));
    assert(!newInv.getDigest('test.txt', 'v3'));
  });

  it('copy', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    await trx.import('/source', '');
    assert.strictEqual(fs.readFileSync(`${wp}/content/metadata.json`, 'utf-8'), '{}');
    await trx.copy('data/a/a.txt', 'data/c/c.txt');
    await trx.commit();
    assert.strictEqual(newInv.getDigest('data/a/a.txt'), newInv.getDigest('data/c/c.txt'));
  });

  it('rename', async () => {
    const trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    await trx.import('/source', '');
    assert.strictEqual(fs.readFileSync(`${wp}/content/metadata.json`, 'utf-8'), '{}');
    const a = newInv.getDigest('data/a/a.txt');
    await trx.rename('data/a/a.txt', 'data/c/c.txt');
    const b = newInv.getDigest('data/c/c.txt');
    assert.strictEqual(a, b);
    assert(fs.existsSync(`${wp}/content/data/c/c.txt`));
    assert(!fs.existsSync(`${wp}/content/data/a/a.txt`));
    await trx.commit();
  });

  it('remove', async () => {
    let trx = await createTransaction();
    const wp = trx._workspaceVersionPath;
    await trx.import('/source', '');
    assert.strictEqual(fs.readFileSync(`${wp}/content/data/a/a.txt`, 'utf-8'), 'data a');
    await trx.remove('data/a/a.txt');
    assert(!fs.existsSync(`${wp}/content/data/a/a.txt`));
    await trx.commit();
    trx = await createTransaction(newInv);
    assert(newInv.getDigest('data/b/b.txt'));
    await trx.remove('data/b/b.txt');
    await trx.commit();
    assert(!newInv.getDigest('data/b/b.txt'));
  });

  it('reinstate', async () => {
    let trx = await createTransaction();
    await trx.import('/source', '');
    await trx.commit();
    assert(newInv.getDigest('metadata.json'));
    trx = await createTransaction(newInv);
    await trx.remove('metadata.json');
    await trx.commit();
    assert(!newInv.getDigest('metadata.json'));
    trx = await createTransaction(newInv);
    await trx.reinstate('metadata.json', 'v1');
    await trx.commit();
    assert(newInv.getDigest('metadata.json'));
  });
});
