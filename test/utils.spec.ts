import assert from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import * as utils from '../src/utils.ts';

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
