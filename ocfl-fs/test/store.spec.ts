import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OcflFsStore } from '../src/store.ts';

describe('OcflFsStore', () => {
  var store = new OcflFsStore();
  // before(function () {
  //   store = new OcflFsStore();
  // });

  it('exists', async () => {
    assert.equal(await store.exists(import.meta.dirname), true);
    assert.equal(await store.exists(path.join(import.meta.dirname, 'object.spec.ts')), true);
    assert.equal(await store.exists('a'), false);
  });

  it('createDir', async () => {
    var p1 = await store.mkdir(path.join(import.meta.dirname, 'a/b/c'));
    assert.equal(p1, path.join(import.meta.dirname, 'a'));
    var p2 = await store.mkdir(path.join(import.meta.dirname, 'a/b/c/d/e'));
    assert.equal(p2, path.join(import.meta.dirname, 'a/b/c/d'));
    await fs.promises.rm(p1!, { recursive: true, force: true });
    // assert.equal(await o._exists('object.spec.ts'), true);
    // assert.equal(await o._exists('a'), false);
  });
});
