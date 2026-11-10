import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as error from '../src/error.ts';
import { createError, ValidationError } from '../src/validation.ts';

describe('error.OcflError', () => {
  it('carries a code and message', () => {
    const e = new error.OcflError('OBJECT_NOT_FOUND', 'missing');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'OcflError');
    assert.equal(e.code, 'OBJECT_NOT_FOUND');
    assert.equal(e.message, 'missing');
  });

  it('is the base of the object errors, which carry their codes', () => {
    const notFound = new error.ObjectNotFoundError('obj');
    const notLoaded = new error.ObjectNotLoadedError('obj');
    assert.ok(notFound instanceof error.OcflError);
    assert.ok(notLoaded instanceof error.OcflError);
    assert.equal(notFound.name, 'ObjectNotFoundError');
    assert.equal(notFound.code, 'OBJECT_NOT_FOUND');
    assert.equal(notLoaded.name, 'ObjectNotLoadedError');
    assert.equal(notLoaded.code, 'OBJECT_NOT_LOADED');
  });

  it('is the base of ValidationError', () => {
    const e = createError('E060', '/obj/inventory.json');
    assert.ok(e instanceof error.OcflError);
    assert.ok(e instanceof ValidationError);
    assert.equal(e.name, 'ValidationError');
    assert.equal(e.code, 'E060');
  });
});
