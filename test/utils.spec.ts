import assert from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import * as utils from '../src/utils.ts';

describe('utils.relativeWithin', () => {
  it('gives a path inside the root relative to it, and the root itself as empty', () => {
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', 'a/b'), 'a/b');
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '/srv/ocfl/a/../b'), 'b');
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '.'), '');
  });

  it('gives nothing for a path outside the root', () => {
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '..'), undefined);
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '../ocfl-other/a'), undefined);
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '/srv'), undefined);
  });

  it('keeps a name inside the root that only starts with two dots', () => {
    assert.strictEqual(utils.relativeWithin('/srv/ocfl', '..a'), '..a');
  });
});

describe('utils.createLimiter', () => {
  it('runs at most the given number of functions at once', async () => {
    const limit = utils.createLimiter(3);
    let running = 0;
    let max = 0;
    const results = await Promise.all(
      [...Array(10).keys()].map((i) =>
        limit(async () => {
          running++;
          max = Math.max(max, running);
          await setTimeout(5);
          running--;
          return i;
        }),
      ),
    );
    assert.deepStrictEqual(results, [...Array(10).keys()]);
    assert.strictEqual(max, 3);
  });

  it('frees the slot of a function that rejects', async () => {
    const limit = utils.createLimiter(1);
    await assert.rejects(limit(async () => Promise.reject(new Error('failed'))));
    assert.strictEqual(await limit(async () => 'next'), 'next');
  });
});
