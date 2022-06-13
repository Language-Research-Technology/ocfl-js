"use strict";

const assert = require("assert");
const utils = require("../lib/utils.js");
const { setTimeout } = require('timers/promises');
const { performance } = require('perf_hooks');



describe("utils.parallelize", function () {
  it("can accept empty array", async function() {
    let input = [];
    let output = await utils.parallelize(input, async(i)=>{
      await setTimeout(10);
      return i;
    });
    assert.equal(output.length, 0);
  });
  it("can run function concurrently", async function() {
    let input = [1,2,3,4,5];
    let startTime = performance.now();
    let output = await utils.parallelize(input, async(i)=>{
      await setTimeout(100);
      return i;
    });
    let endTime = performance.now();
    assert(endTime - startTime < 110);
  });
  it("can work with input array length less than concurrency count", async function() {
    let input = [1,2,3];
    let seq = [];
    let output = await utils.parallelize(input.concat([]), async(i)=>{
      await setTimeout(100+i*2);
      seq.push(i);
      return i;
    });
    assert.deepStrictEqual(input, output);
    assert.deepStrictEqual(input, seq);
  });
  it("can work with input array length greater than concurrency count", async function() {
    let input = [...Array(30).keys()];
    let startTime = performance.now();
    let output = await utils.parallelize(input.concat([]), async(i)=>{
      await setTimeout(100);
      return i;
    });
    let endTime = performance.now();
    assert.deepStrictEqual(input, output);
    assert(endTime - startTime < 310);
  });
  it("can work with callback that returns a promise", async function() {
    let input = [...Array(30).keys()];
    let startTime = performance.now();
    await utils.parallelize(input.concat([]), async(i)=>setTimeout(100));
    let endTime = performance.now();
    assert(endTime - startTime < 310);
  });
});