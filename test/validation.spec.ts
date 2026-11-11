import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createError } from '../src/validation.ts';
import { ocflError } from './helpers/ocfl-error.ts';

describe('validation.createError', () => {
  it('builds an INVALID_OBJECT error carrying the spec code, with the rule, path and detail in its message', () => {
    const e = createError('E060', '/obj/inventory.json', 'recorded=a actual=b');
    assert.ok(ocflError('INVALID_OBJECT', 'E060')(e));
    assert.equal(e.name, 'OcflError');
    assert.equal(e.message, 'E060: The digest sidecar file must contain the digest of the inventory file. At /obj/inventory.json (recorded=a actual=b)');
  });

  it('has a message for a missing inventory sidecar', () => {
    const e = createError('E058', '/obj/inventory.json');
    assert.ok(ocflError('INVALID_OBJECT', 'E058')(e));
    assert.match(e.message, /^E058: Every occurrence of an inventory file MUST have an accompanying sidecar file/);
  });

  for (const code of ['E069', 'E070', 'E080'] as const) {
    it(`builds an INVALID_STORAGE_ROOT error for ${code}, a rule about the storage root`, () => {
      assert.ok(ocflError('INVALID_STORAGE_ROOT', code)(createError(code, '/root')));
    });
  }

  it('builds an INVALID_OBJECT error for E007, the rule about the declaration of an object', () => {
    assert.ok(ocflError('INVALID_OBJECT', 'E007')(createError('E007', '/root/obj')));
  });

  it('rejects codes it has no message for', () => {
    assert.throws(() => createError('E001' as never, '/obj'), RangeError);
    assert.throws(() => createError('toString' as never, '/obj'), RangeError);
  });
});
