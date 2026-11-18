import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { Draft } from '../src/index.ts';
import * as entryPoint from '../src/index.ts';
import { DETAILS, useTempRoots } from './helpers/drafts.ts';

/** Every function a caller can reach on `value`, through its own properties and its prototypes */
function callableMembers(value: object): string[] {
  const names = new Set<string>();
  for (let level = value; level !== Object.prototype && level !== Function.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      const { value: member } = Object.getOwnPropertyDescriptor(level, name) ?? {};
      if (typeof member === 'function' && name !== 'constructor') {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

describe('the public entry point', () => {
  it('exports createStorageRoot, openStorageRoot, OcflError and isOcflError, and nothing else', () => {
    assert.deepStrictEqual(Object.keys(entryPoint).sort(), ['OcflError', 'createStorageRoot', 'isOcflError', 'openStorageRoot']);
    assert.strictEqual(typeof entryPoint.isOcflError, 'function');
    assert.strictEqual(typeof entryPoint.createStorageRoot, 'function');
    assert.strictEqual(typeof entryPoint.openStorageRoot, 'function');
    assert.strictEqual(Object.getPrototypeOf(entryPoint.OcflError), Error);
  });
});

describe('a draft', () => {
  const { newRoot } = useTempRoots('ocfl-public-draft-');

  it('offers the draft operations and nothing else, on itself or its class', async () => {
    const root = await newRoot();
    let draft: Draft | undefined;
    await root.create('an-object', DETAILS, async (given) => {
      draft = given;
    });
    assert.ok(draft);
    assert.deepStrictEqual(callableMembers(draft), ['clear', 'copy', 'files', 'import', 'reinstate', 'remove', 'rename', 'write']);
    assert.deepStrictEqual(callableMembers(draft.constructor), []);
  });

  it('cannot be made by its class, which would skip the lock', async () => {
    const root = await newRoot();
    let draft: Draft | undefined;
    await root.create('an-object', DETAILS, async (given) => {
      draft = given;
    });
    const DraftClass = draft!.constructor as new (...args: unknown[]) => Draft;
    assert.throws(
      () => new DraftClass(Symbol('starting a draft')),
      (e) => e instanceof TypeError && /made only by an update/.test(e.message),
    );
  });
});
