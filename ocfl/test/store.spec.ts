import assert from 'node:assert';
import { describe, it } from 'node:test';
import { OcflStore } from '../src/index.ts';

class OcflTest1Store extends OcflStore {}

class OcflTest2Store extends OcflStore {
  static instances = new Map();
}

describe('OcflStore default readFile', () => {
  const hello = [0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f];

  function storeYielding(...chunks: unknown[]) {
    class Store extends OcflStore {
      override async createReadable() {
        return new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        });
      }
    }
    return new Store();
  }

  it('decodes byte chunks when given an encoding name', async () => {
    assert.strictEqual(await storeYielding(new Uint8Array(hello)).readFile('a.txt', 'utf8'), 'héllo');
  });

  it('decodes byte chunks when given an encoding option', async () => {
    assert.strictEqual(await storeYielding(new Uint8Array(hello)).readFile('a.txt', { encoding: 'utf8' }), 'héllo');
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const store = storeYielding(new Uint8Array(hello.slice(0, 2)), new Uint8Array(hello.slice(2)));
    assert.strictEqual(await store.readFile('a.txt', 'utf8'), 'héllo');
  });

  it('encodes byte chunks the same way Buffer does for hex and base64', async () => {
    assert.strictEqual(await storeYielding(new Uint8Array(hello)).readFile('a.txt', 'hex'), '68c3a96c6c6f');
    assert.strictEqual(await storeYielding(new Uint8Array(hello)).readFile('a.txt', 'base64'), 'aMOpbGxv');
  });

  it('resolves an empty stream to an empty string when given an encoding', async () => {
    assert.strictEqual(await storeYielding().readFile('a.txt', 'utf8'), '');
  });

  it('returns binary content byte for byte when given no encoding', async () => {
    const binary = [0xff, 0xfe, 0x00, 0x80];
    const result = await storeYielding(new Uint8Array(binary.slice(0, 2)), new Uint8Array(binary.slice(2))).readFile('a.bin');
    assert.ok(result instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(result), binary);
  });

  it('returns a plain Uint8Array that owns its memory when given no encoding', async () => {
    const result = await storeYielding(new Uint8Array([1, 2]), new Uint8Array([3])).readFile('a.bin');
    assert.strictEqual(Object.getPrototypeOf(result), Uint8Array.prototype);
    assert.strictEqual(result.buffer.byteLength, 3);
  });

  it('returns content spanning many chunks complete, with and without an encoding', async () => {
    const chunkCount = 40;
    const chunkSize = 1024;
    const chunks = Array.from({ length: chunkCount }, () => new Uint8Array(chunkSize).fill(0x61));
    const text = await storeYielding(...chunks).readFile('a.txt', 'utf8');
    assert.strictEqual(text, 'a'.repeat(chunkCount * chunkSize));
    const bytes = await storeYielding(...chunks).readFile('a.txt');
    assert.strictEqual(bytes.byteLength, chunkCount * chunkSize);
    assert.ok(bytes.every((byte) => byte === 0x61));
  });

  it('returns string chunks unchanged when given an encoding', async () => {
    assert.strictEqual(await storeYielding('héllo').readFile('a.txt', 'utf8'), 'héllo');
    assert.strictEqual(await storeYielding('68c3', 'a96c').readFile('a.txt', 'hex'), '68c3a96c');
  });

  it('combines a string chunk followed by a byte chunk', async () => {
    assert.strictEqual(await storeYielding('hé', new Uint8Array([0x6c, 0x6c, 0x6f])).readFile('a.txt', 'utf8'), 'héllo');
  });

  it('accepts ArrayBuffer chunks', async () => {
    assert.strictEqual(await storeYielding(new Uint8Array(hello).buffer).readFile('a.txt', 'utf8'), 'héllo');
  });

  it('still resolves string chunks to a string when given no encoding', async () => {
    assert.strictEqual(await storeYielding('hello').readFile('a.txt'), 'hello');
  });
});

describe('OcflStore default removeIfEmpty', () => {
  function storeWith(readdir: () => Promise<string[]>) {
    const removed: string[] = [];
    class Store extends OcflStore {
      override readdir = readdir;
      override async remove(filePath: string) {
        removed.push(filePath);
      }
    }
    return { store: new Store(), removed };
  }

  it('removes an empty directory', async () => {
    const { store, removed } = storeWith(async () => []);
    await store.removeIfEmpty('/dir');
    assert.deepStrictEqual(removed, ['/dir']);
  });

  it('keeps a directory that has content', async () => {
    const { store, removed } = storeWith(async () => ['a.txt']);
    await store.removeIfEmpty('/dir');
    assert.deepStrictEqual(removed, []);
  });

  it('ignores a missing directory', async () => {
    const { store, removed } = storeWith(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await store.removeIfEmpty('/dir');
    assert.deepStrictEqual(removed, []);
  });

  it('reports any other failure', async () => {
    const { store } = storeWith(async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    await assert.rejects(store.removeIfEmpty('/dir'), { code: 'EACCES' });
  });
});

describe('Subclassing OcflStore class', () => {
  it('always get new instance if instances property is not included', () => {
    const s1 = OcflTest1Store.getInstance();
    const s2 = OcflTest1Store.getInstance();
    assert.ok(s1 instanceof OcflTest1Store);
    assert.notStrictEqual(s1, s2);
  });
  it('always get same instance if options are the same', () => {
    const options = {};
    let s1 = OcflTest2Store.getInstance();
    let s2 = OcflTest2Store.getInstance();
    assert.ok(s1 instanceof OcflTest2Store);
    assert.strictEqual(s1, s2);
    s1 = OcflTest2Store.getInstance(options);
    s2 = OcflTest2Store.getInstance(options);
    assert.strictEqual(s1, s2);
    s1 = OcflTest2Store.getInstance(options);
    s2 = OcflTest2Store.getInstance({});
    assert.notStrictEqual(s1, s2);
  });
});
