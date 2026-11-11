import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as error from '../src/error.ts';
import { createError, ValidationError } from '../src/validation.ts';
import { ocflError } from './ocfl-error.ts';

describe('error.OcflError', () => {
  it('carries a code and message', () => {
    const e = new error.OcflError('OBJECT_NOT_FOUND', 'missing');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'OcflError');
    assert.equal(e.code, 'OBJECT_NOT_FOUND');
    assert.equal(e.message, 'missing');
    assert.equal('ocflCode' in e, false);
    assert.equal('lockedAt' in e, false);
    assert.equal('cause' in e, false);
  });

  it('carries the OCFL validation code and the wrapped error of a damaged object', () => {
    const cause = new SyntaxError('Unexpected end of JSON input');
    const e = new error.OcflError('INVALID_OBJECT', 'damaged', { ocflCode: 'E060', cause });
    assert.equal(e.code, 'INVALID_OBJECT');
    assert.equal(e.ocflCode, 'E060');
    assert.equal(e.cause, cause);
    assert.equal('lockedAt' in e, false);
  });

  it('leaves out a field whose option is undefined', () => {
    const e = new error.OcflError('INVALID_OBJECT', 'damaged', { ocflCode: undefined, lockedAt: undefined, cause: undefined });
    assert.equal('ocflCode' in e, false);
    assert.equal('lockedAt' in e, false);
    assert.equal('cause' in e, false);
  });

  it('carries when the lock was taken', () => {
    const lockedAt = new Date('2026-01-02T03:04:05Z');
    const e = new error.OcflError('UPDATE_IN_PROGRESS', 'locked', { lockedAt });
    assert.equal(e.lockedAt, lockedAt);
    assert.equal('ocflCode' in e, false);
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

  it('gives a ValidationError its own code as the OCFL validation code', () => {
    assert.equal(createError('E060', '/obj/inventory.json').ocflCode, 'E060');
  });
});

describe('ocflError matcher', () => {
  const damaged = new error.OcflError('INVALID_OBJECT', 'damaged', { ocflCode: 'E060' });

  it('matches on the code alone', () => {
    assert.equal(ocflError('INVALID_OBJECT')(damaged), true);
    assert.equal(ocflError('INVALID_STORAGE_ROOT')(damaged), false);
    assert.equal(ocflError('INVALID_OBJECT')(new Error('damaged')), false);
  });

  it('matches on the OCFL validation code when given one', () => {
    assert.equal(ocflError('INVALID_OBJECT', 'E060')(damaged), true);
    assert.equal(ocflError('INVALID_OBJECT', 'E036')(damaged), false);
    assert.equal(ocflError('INVALID_OBJECT', 'E060')(new error.OcflError('INVALID_OBJECT', 'damaged')), false);
  });
});
