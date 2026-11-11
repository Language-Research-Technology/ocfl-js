import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createError } from '../src/validation.ts';

describe('validation.createError', () => {
  it('builds an error with the spec code, message and path', () => {
    const e = createError('E060', '/obj/inventory.json', 'recorded=a actual=b');
    assert.equal(e.name, 'ValidationError');
    assert.equal(e.code, 'E060');
    assert.equal(e.description, 'The digest sidecar file must contain the digest of the inventory file.');
    assert.equal(e.path, '/obj/inventory.json');
    assert.equal(e.message, 'E060: The digest sidecar file must contain the digest of the inventory file. At /obj/inventory.json (recorded=a actual=b)');
  });

  it('has a message for a missing inventory sidecar', () => {
    const e = createError('E058', '/obj/inventory.json');
    assert.equal(e.ocflCode, 'E058');
    assert.match(e.message, /^E058: Every occurrence of an inventory file MUST have an accompanying sidecar file/);
  });

  it('rejects codes it has no message for', () => {
    assert.throws(() => createError('E001' as never, '/obj'), RangeError);
    assert.throws(() => createError('toString' as never, '/obj'), RangeError);
  });
});
