import assert from 'node:assert';
import { extensions } from '../../src/index.ts';

const { FlatDirectStorageLayout } = extensions;

describe('FlatDirectStorageLayout class', () => {
  const layout = FlatDirectStorageLayout.create();

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

    assert.throws(() => layout.map(id1));
    assert.throws(() => layout.map(id2));
  });
});
