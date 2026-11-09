import assert from 'node:assert';
import { describe, it } from 'node:test';
import { OcflExtension, type OcflExtensionConfig, OcflStorageLayout } from '../src/index.ts';

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

  it('runs setup with the library when an extension is registered', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    class SetupExt extends OcflExtension {
      static get NAME() {
        return '9999-setup-extension';
      }
      static async setup(ocfl: typeof import('../src/index.ts')) {
        resolve(ocfl.OcflExtension);
      }
    }
    SetupExt.register();
    assert.strictEqual(await promise, OcflExtension);
  });

  describe('a custom layout', () => {
    class PrefixLayout extends OcflStorageLayout<{ prefix: string }> {
      static get NAME() {
        return '9999-prefix-layout';
      }
      static get DESCRIPTION() {
        return 'Prefixes an object id';
      }
      constructor(config?: OcflExtensionConfig) {
        super(config, { prefix: 'objects-' });
      }
      map(id: string) {
        return `${this.get('prefix')}${id}`;
      }
    }
    PrefixLayout.register();

    it('is found by registered name and by class name', () => {
      assert.strictEqual(OcflStorageLayout.class('9999-prefix-layout'), PrefixLayout);
      assert.strictEqual(OcflStorageLayout.class('PrefixLayout'), PrefixLayout);
      assert.ok(OcflStorageLayout.classes.some((c) => c.NAME === '9999-prefix-layout'));
      assert.ok(OcflExtension.classes.some((c) => c.NAME === '9999-prefix-layout'));
    });

    it('is not found as a layout when it is only an extension', () => {
      class PlainExt extends OcflExtension {
        static get NAME() {
          return '9999-plain-extension';
        }
      }
      PlainExt.register();
      assert.strictEqual(OcflExtension.class('9999-plain-extension'), PlainExt);
      assert.strictEqual(OcflStorageLayout.class('9999-plain-extension'), undefined);
    });

    it('is created with its parameters and maps ids', () => {
      const layout = PrefixLayout.create({ extensionName: '9999-prefix-layout', prefix: 'custom-' });
      assert.ok(layout instanceof PrefixLayout);
      assert.strictEqual(layout.map('abc'), 'custom-abc');
    });

    it('exposes its name, description, version, parameters and config', () => {
      const layout = new PrefixLayout({ prefix: 'custom-' });
      assert.strictEqual(PrefixLayout.NAME, '9999-prefix-layout');
      assert.strictEqual(PrefixLayout.DESCRIPTION, 'Prefixes an object id');
      assert.strictEqual(layout.name, '9999-prefix-layout');
      assert.strictEqual(layout.description, 'Prefixes an object id');
      assert.strictEqual(layout.version, '1.0');
      assert.strictEqual(layout.parameters.prefix, 'custom-');
      assert.deepStrictEqual(layout.config, { extensionName: '9999-prefix-layout', prefix: 'custom-' });
    });

    it('reads and changes only its declared parameters', () => {
      const layout = new PrefixLayout();
      assert.strictEqual(layout.get('prefix'), 'objects-');
      layout.set('prefix', 'changed-');
      layout.set('undeclared', 'ignored');
      assert.strictEqual(layout.get('prefix'), 'changed-');
      assert.strictEqual(layout.get('undeclared'), undefined);
    });
  });
});
