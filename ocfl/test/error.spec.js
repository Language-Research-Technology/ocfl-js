import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as error from '../src/error.ts';

describe('error.NotImplementedError', () => {
  it('can show correct name and message', async () => {
    try {
      throw new error.NotImplementedError('test');
    } catch (error) {
      assert.equal(error.name, 'NotImplementedError');
      assert.equal(error.message, 'Method test has not been implemented');
    }
  });
});
