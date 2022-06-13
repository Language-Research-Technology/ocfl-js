//@ts-check
'use strict';

const { Transform } = require("stream");

const setImmediate = (1, eval)('this').setImmediate
  || function (fn) { setTimeout(fn, 0) }

/**
* Effectively a PassThrough stream that taps to chunks flow
* and accumulating the hash
*/
function HashThrough(createHash) {
  const hashThrough = new Transform();

  const hash = createHash()

  hashThrough._transform = function (chunk, encoding, cb) {
    setImmediate(_ => {
      try {
        hash.update(chunk)
        cb(null, chunk)
      } catch (err) {
        cb(err)
      }
    })
  }

  // bind the digest function to hash object
  hashThrough.digest = format => hash.digest(format)

  return hashThrough
}

/**
 * 
 * @param {*} data 
 */
function dataSourceAsIterable(data) {
  let d = data;
  if (ArrayBuffer.isView(data) && data.buffer) {
    d = Buffer.from(data.buffer);
  }
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    d = [data];
  }
  return d;
}
// 
/**
 * @template T
 * @param {T[]} inputStack - An array in which each element will be passed to the asyncFn function callback. This array will be consumed during the process.
 * @param {function(T):Promise} asyncFn - An async function that will be run in parallel
 * @param {number} count - Maximum number of concurrency
 */
async function parallelize(inputStack, asyncFn, count=10) {
  let promises = [];
  let len = inputStack.length > count ? count : inputStack.length;
  let result = [];
  while (len--) {
    promises.push((async () => {
      let input;
      while (inputStack.length) {
        let input = inputStack.pop();
        let index = inputStack.length;
        try {
          result[index] = await asyncFn(input);
        } catch (error) {
          result[index] = error;
        }
      }
    })().catch(err=>{}));
  }
  await Promise.all(promises);
  return result;
}

module.exports = {
  parallelize,
  dataSourceAsIterable
};
