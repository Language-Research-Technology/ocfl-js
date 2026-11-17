import assert from 'node:assert';
import { describe, it } from 'node:test';
import { specViolation } from '../src/ocfl-rules.ts';
import { ocflError } from './helpers/ocfl-error.ts';

describe('ocfl-rules.specViolation', () => {
  it('builds an INVALID_OBJECT error carrying the spec code, with the rule, path and detail in its message', () => {
    const e = specViolation('E060', '/obj/inventory.json', 'recorded=a actual=b');
    assert.ok(ocflError('INVALID_OBJECT', 'E060')(e));
    assert.equal(e.name, 'OcflError');
    assert.equal(e.message, 'E060: The digest sidecar file must contain the digest of the inventory file. At /obj/inventory.json (recorded=a actual=b)');
  });

  it('names an object by its id, not as a path, when the fault is in an inventory already read', () => {
    const e = specViolation('E050', { objectId: 'item-1' }, 'digest "abc" is not in the manifest');
    assert.ok(ocflError('INVALID_OBJECT', 'E050')(e));
    assert.match(e.message, / In the object <item-1> \(digest "abc" is not in the manifest\)$/);
    assert.doesNotMatch(e.message, / At /);
  });

  it('keeps the cause it is given', () => {
    const cause = new SyntaxError('Unexpected end of JSON input');
    assert.strictEqual(specViolation('E033', '/obj/inventory.json', 'not valid JSON', { cause }).cause, cause);
  });

  it('has a message for a missing inventory sidecar', () => {
    const e = specViolation('E058', '/obj/inventory.json');
    assert.ok(ocflError('INVALID_OBJECT', 'E058')(e));
    assert.match(e.message, /^E058: Every occurrence of an inventory file MUST have an accompanying sidecar file/);
  });

  for (const code of ['E069', 'E070', 'E080'] as const) {
    it(`builds an INVALID_STORAGE_ROOT error for ${code}, a rule about the storage root`, () => {
      assert.ok(ocflError('INVALID_STORAGE_ROOT', code)(specViolation(code, '/root')));
    });
  }

  it('builds an INVALID_OBJECT error for E007, the rule about the declaration of an object', () => {
    assert.ok(ocflError('INVALID_OBJECT', 'E007')(specViolation('E007', '/root/obj')));
  });
});
