import assert from 'node:assert';
import { describe, it } from 'node:test';
import { OcflExtension } from '../src/index.ts';

describe('OcflExtension class', () => {
  it('can register new extension', () => {
    const len = OcflExtension.classes.length;
    class TestExt extends OcflExtension {
      static get NAME() {
        return '9999-test-extension';
      }
    }
    TestExt.register();
    assert.strictEqual(OcflExtension.class('9999-test-extension'), TestExt);
    assert.strictEqual(OcflExtension.classes.length, len + 1);
  });
});
