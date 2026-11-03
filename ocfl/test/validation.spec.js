'use strict';
const assert = require('assert');
const { createError } = require('../lib/validation.js');

describe('validation.createError', () => {
  it('builds an error with the spec code, message and path', () => {
    const e = createError('E060', '/obj/inventory.json', 'recorded=a actual=b');
    assert.equal(e.name, 'ValidationError');
    assert.equal(e.code, 'E060');
    assert.equal(e.description, 'The digest sidecar file must contain the digest of the inventory file.');
    assert.equal(e.path, '/obj/inventory.json');
    assert.equal(e.message, 'E060: The digest sidecar file must contain the digest of the inventory file. At /obj/inventory.json (recorded=a actual=b)');
  });

  it('rejects codes it has no message for', () => {
    assert.throws(() => createError(/** @type {any} */ ('E001'), '/obj'), RangeError);
    assert.throws(() => createError(/** @type {any} */ ('toString'), '/obj'), RangeError);
  });
});
