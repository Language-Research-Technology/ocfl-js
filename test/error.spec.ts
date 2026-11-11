import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ocflError as makeError, OcflError } from '../src/error.ts';
import { ocflError } from './helpers/ocfl-error.ts';

describe('OcflError', () => {
  it('carries a code and message', () => {
    const e = makeError('OBJECT_NOT_FOUND', 'missing');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof OcflError);
    assert.equal(e.name, 'OcflError');
    assert.equal(e.code, 'OBJECT_NOT_FOUND');
    assert.equal(e.message, 'missing');
    assert.equal('ocflCode' in e, false);
    assert.equal('lockedAt' in e, false);
    assert.equal('cause' in e, false);
  });

  it('carries the OCFL validation code and the wrapped error of a damaged object', () => {
    const cause = new SyntaxError('Unexpected end of JSON input');
    const e = makeError('INVALID_OBJECT', 'damaged', { ocflCode: 'E060', cause });
    assert.equal(e.code, 'INVALID_OBJECT');
    assert.equal(e.ocflCode, 'E060');
    assert.equal(e.cause, cause);
    assert.equal('lockedAt' in e, false);
  });

  it('leaves out a field whose option is undefined', () => {
    const e = makeError('INVALID_OBJECT', 'damaged', { ocflCode: undefined, lockedAt: undefined, cause: undefined });
    assert.equal('ocflCode' in e, false);
    assert.equal('lockedAt' in e, false);
    assert.equal('cause' in e, false);
  });

  it('carries when the lock was taken', () => {
    const lockedAt = new Date('2026-01-02T03:04:05Z');
    const e = makeError('UPDATE_IN_PROGRESS', 'locked', { lockedAt });
    assert.equal(e.lockedAt, lockedAt);
    assert.equal('ocflCode' in e, false);
  });

  it('has a code for an object whose zero-padded version names are used up, which is not a damaged object', () => {
    const e = makeError('VERSION_LIMIT_REACHED', 'full');
    assert.ok(ocflError('VERSION_LIMIT_REACHED')(e));
    assert.equal(ocflError('INVALID_OBJECT')(e), false);
    assert.equal('ocflCode' in e, false);
  });
});

describe('ocflError matcher', () => {
  const damaged = makeError('INVALID_OBJECT', 'damaged', { ocflCode: 'E060' });

  it('matches on the code alone', () => {
    assert.equal(ocflError('INVALID_OBJECT')(damaged), true);
    assert.equal(ocflError('INVALID_STORAGE_ROOT')(damaged), false);
    assert.equal(ocflError('INVALID_OBJECT')(new Error('damaged')), false);
  });

  it('matches on the OCFL validation code when given one', () => {
    assert.equal(ocflError('INVALID_OBJECT', 'E060')(damaged), true);
    assert.equal(ocflError('INVALID_OBJECT', 'E036')(damaged), false);
    assert.equal(ocflError('INVALID_OBJECT', 'E060')(makeError('INVALID_OBJECT', 'damaged')), false);
  });
});
