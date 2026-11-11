import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as entryPoint from '../src/index.ts';

describe('the public entry point', () => {
  it('exports createStorageRoot, openStorageRoot and OcflError, and nothing else', () => {
    assert.deepStrictEqual(Object.keys(entryPoint).sort(), ['OcflError', 'createStorageRoot', 'openStorageRoot']);
    assert.strictEqual(typeof entryPoint.createStorageRoot, 'function');
    assert.strictEqual(typeof entryPoint.openStorageRoot, 'function');
    assert.strictEqual(Object.getPrototypeOf(entryPoint.OcflError), Error);
  });
});
