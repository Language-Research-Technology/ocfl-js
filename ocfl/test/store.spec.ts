import assert from 'node:assert';
import { describe, it } from 'node:test';
import { OcflStore } from '../src/index.ts';

class OcflTest1Store extends OcflStore {}

class OcflTest2Store extends OcflStore {
  static instances = new Map();
}

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
