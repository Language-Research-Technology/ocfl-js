//@ts-check
'use strict';

const path = require('path');
const validation = require('./validation.js');
const { OCFL_VERSIONS, NAMASTE_T } = require('./constants').OcflConstants;


/** 
 * @typedef {import('./store').OcflStore} OcflStore
 */

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
async function parallelize(inputStack, asyncFn, count = 10) {
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
    })().catch(err => { }));
  }
  await Promise.all(promises);
  return result;
}

async function isDirEmpty(store, dirPath) {
  let dir, de;
  try {
    dir = await store.opendir(dirPath);
    de = await dir.read();
    await dir.close();
  } catch (error) {
    return error.code === 'ENOENT';
  }
  return !de;
}

/**
 * Check if there is any valid namaste in the rootPath and return the version number
 * @param {OcflStore} store 
 * @param {string} prefix 
 * @param {string} rootPath 
 */
async function findNamasteVersion(store, prefix, rootPath) {
  let namastePath = path.join(rootPath, NAMASTE_T + prefix);
  let version;
  try {
    version = await Promise.any(OCFL_VERSIONS.map(async (v) =>
      /**@type {string}*/(await store.readFile(namastePath + v, 'utf8')) === prefix + v + '\n' ? v : null));
    if (!version) return ''; // namaste exists but invalid
  } catch (error) {
    if (!error.errors || error.errors.some(e => e.code !== 'ENOENT')) throw error;
  }
  return version;
}

const testSymbol = Symbol('testSymbol');

module.exports = {
  parallelize,
  dataSourceAsIterable,
  isDirEmpty,
  findNamasteVersion,
  testSymbol
};
