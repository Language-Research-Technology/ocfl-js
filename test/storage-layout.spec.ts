import assert from 'node:assert';
import { describe, it } from 'node:test';
import ocfl from '../src/index.ts';
import { INVALID_LAYOUT_PARAMETERS, UNSUPPORTED_LAYOUT_NAMES } from './helpers/layouts.ts';
import { ocflError } from './ocfl-error.ts';

const storageLayout = (layout: unknown) => ocfl.storageLayout(layout as never);

describe('choosing a layout that is not supported', () => {
  for (const name of UNSUPPORTED_LAYOUT_NAMES) {
    it(`rejects ${name} through storageLayout()`, () => {
      assert.throws(() => storageLayout(name), ocflError('UNSUPPORTED_LAYOUT'));
      assert.throws(() => storageLayout({ extensionName: name }), ocflError('UNSUPPORTED_LAYOUT'));
    });
  }

  it('rejects a layout object through storageLayout()', () => {
    const layout = ocfl.storageLayout('0002-flat-direct-storage-layout');
    assert.throws(() => storageLayout(layout), ocflError('UNSUPPORTED_LAYOUT'));
  });

  it('rejects a config object with no extensionName through storageLayout()', () => {
    assert.throws(() => storageLayout({ tupleSize: 2 }), ocflError('UNSUPPORTED_LAYOUT'));
  });

  it('rejects an empty name through storageLayout()', () => {
    assert.throws(() => storageLayout(''), ocflError('UNSUPPORTED_LAYOUT'));
  });

  it('rejects null through storageLayout()', () => {
    assert.throws(() => storageLayout(null), ocflError('UNSUPPORTED_LAYOUT'));
  });
});

describe('choosing a layout with invalid parameters', () => {
  for (const [problem, layout] of INVALID_LAYOUT_PARAMETERS) {
    it(`rejects ${problem} through storageLayout()`, () => {
      assert.throws(() => storageLayout(layout), ocflError('INVALID_LAYOUT_CONFIG'));
    });
  }
});

describe('storageLayout without a loaded storage', () => {
  it('maps an id with the 0003 layout', () => {
    assert.strictEqual(ocfl.storageLayout('0003-hash-and-id-n-tuple-storage-layout').map('object-01'), '3c0/ff4/240/object-01');
  });

  it('maps an id with the 0004 layout', () => {
    assert.strictEqual(
      ocfl.storageLayout('0004-hashed-n-tuple-storage-layout').map('object-01'),
      '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4',
    );
  });
});
