'use strict';
const assert = require('assert');
const utils = require('../lib/utils.js');
const { setTimeout } = require('timers/promises');
const { performance } = require('perf_hooks');

describe('utils.parallelize', () => {
  it('can accept empty array', async () => {
    const input = [];
    const output = await utils.parallelize(input, async (i) => {
      await setTimeout(10);
      return i;
    });
    assert.equal(output.length, 0);
  });
  it('can run function concurrently', async () => {
    const input = [1, 2, 3, 4, 5];
    const startTime = performance.now();
    const output = await utils.parallelize(input, async (i) => {
      await setTimeout(100);
      return i;
    });
    const endTime = performance.now();
    assert(endTime - startTime < 110);
  });
  it('can work with input array length less than concurrency count', async () => {
    const input = [1, 2, 3];
    const seq = [];
    const output = await utils.parallelize(input.concat([]), async (i) => {
      await setTimeout(100 + i * 2);
      seq.push(i);
      return i;
    });
    assert.deepStrictEqual(input, output);
    assert.deepStrictEqual(input, seq);
  });
  it('can work with input array length greater than concurrency count', async () => {
    const input = [...Array(30).keys()];
    const startTime = performance.now();
    const output = await utils.parallelize(input.concat([]), async (i) => {
      await setTimeout(100);
      return i;
    });
    const endTime = performance.now();
    assert.deepStrictEqual(input, output);
    //console.log(endTime - startTime);
    assert(endTime - startTime < 320);
  });
  it('can work with callback that returns a promise', async () => {
    const input = [...Array(30).keys()];
    const startTime = performance.now();
    await utils.parallelize(input.concat([]), async (i) => setTimeout(100));
    const endTime = performance.now();
    assert(endTime - startTime < 320);
  });
});

describe('utils.joinTypedArray', () => {
  it('can join Uint8Array', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const joined = utils.joinTypedArray(a, b);
    assert.deepStrictEqual(Array.from(joined), [1, 2, 3, 4, 5, 6]);
  });
  it('can join by resizing', async () => {
    const ab = new ArrayBuffer(0, { maxByteLength: 16 * 1024 });
    const a = new Uint8Array(ab);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([4, 5, 6]);
    let joined = utils.joinTypedArray(a, b);
    joined = utils.joinTypedArray(joined, c);
    assert.deepStrictEqual(Array.from(joined), [1, 2, 3, 4, 5, 6]);
  });
  //
});
