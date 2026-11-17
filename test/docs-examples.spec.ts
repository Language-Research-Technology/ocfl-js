import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLayout, type LayoutConfig } from '../src/layouts/index.ts';

const PATH_DIRECT = '000N-path-direct-storage-layout';
const HASHED = '0004-hashed-n-tuple-storage-layout';

const example = (file: string) => readFileSync(new URL(`../website/src/examples/${file}`, import.meta.url), 'utf8');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a path stated in a comment, where … stands for any run of characters, is `actual` */
const states = (stated: string, actual: string) => new RegExp(`^${stated.split('…').map(escapeRegExp).join('.+')}$`).test(actual);

describe('the object roots that the docs examples state', () => {
  it('the home page path-direct example', () => {
    const source = example('index/path-direct-layout.ts');
    const root = source.match(/createStorageRoot\('([^']+)'/)?.[1];
    const id = source.match(/root\.create\('([^']+)'/)?.[1];
    const stored = source.match(/\/\/ Stored in (\S+)/)?.[1];
    assert.ok(root && id && stored, 'the example no longer has a storage root path, an object id and a "Stored in" comment');
    assert.strictEqual(stored, path.posix.join(root, createLayout({ extensionName: PATH_DIRECT }).map(id)));
  });

  it('the home page example of layout options, with and without the option', () => {
    const options: LayoutConfig[] = [
      { extensionName: PATH_DIRECT, omitScheme: true },
      { extensionName: HASHED, shortObjectRoot: true },
    ];
    const statements = [...example('index/choose-layout.ts').matchAll(/\/\/ (\S+) is stored in (\S+), not (\S+)\nawait createStorageRoot\('([^']+)'/g)];
    assert.strictEqual(statements.length, options.length, 'the example no longer has one "is stored in …, not …" comment per storage root');
    for (const [i, [, id = '', stored = '', not = '', root = '']] of statements.entries()) {
      const layout = options[i];
      assert.ok(layout);
      assert.ok(states(stored, path.posix.join(root, createLayout(layout).map(id))), `${id} with ${JSON.stringify(layout)}`);
      assert.ok(states(not, path.posix.join(root, createLayout({ extensionName: layout.extensionName }).map(id))), `${id} without the option`);
    }
  });
});
