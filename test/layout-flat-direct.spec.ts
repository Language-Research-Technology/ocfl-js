import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createLayout } from '../src/extensions/index.ts';

describe('the 0002 flat direct layout', () => {
  const layout = createLayout({ extensionName: '0002-flat-direct-storage-layout' });

  it('can map valid id', () => {
    const id1 = 'object-01';
    const id2 = '..hor_rib:lé-$id';

    assert.strictEqual(layout.map(id1), id1);
    assert.strictEqual(layout.map(id2), id2);
  });

  it('can throw error for invalid id', () => {
    const id1 = 'info:fedora/object-01';
    const id2 =
      'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij';

    const expected = { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' };
    assert.throws(() => layout.map(id1), expected);
    assert.throws(() => layout.map(id2), expected);
    assert.throws(() => layout.map('extensions'), expected);
  });

  it('rejects the ids . and .., which map to the storage root and its parent', () => {
    for (const id of ['.', '..']) {
      assert.throws(() => layout.map(id), { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' }, id);
    }
  });

  it('rejects an id over 255 UTF-8 bytes, which no file system can name, and maps one of exactly 255', () => {
    const expected = { name: 'OcflError', code: 'ID_INCOMPATIBLE_WITH_LAYOUT' };
    assert.throws(() => layout.map('é'.repeat(128)), expected);
    assert.throws(() => layout.map('x'.repeat(256)), expected);
    assert.strictEqual(layout.map(`${'é'.repeat(127)}x`), `${'é'.repeat(127)}x`);
    assert.strictEqual(layout.map('x'.repeat(255)), 'x'.repeat(255));
  });
});
