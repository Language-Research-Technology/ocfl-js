import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { OcflFile, OcflObject, Version } from '../src/index.ts';
import { createObject, DETAILS, objectRootOf, useTempRoots } from './helpers/drafts.ts';
import { rewriteInventory, upperCased } from './helpers/storage-roots.ts';

describe('when a file was created and modified', () => {
  const { newRoot } = useTempRoots('ocfl-file-dates-');

  it('gives the only version of an object for both', async () => {
    const object = await createObject(await newRoot(), 'one-version', { 'a.txt': 'a' });
    const file: OcflFile = object.head.files.get('a.txt')!;
    assert.strictEqual(file.createdIn, object.head);
    assert.strictEqual(file.modifiedIn, object.head);
    assert.strictEqual(file.createdAt, object.head.createdAt);
    assert.strictEqual(file.modifiedAt, object.head.createdAt);
  });

  it('counts content changed back to an earlier content as modified again', async () => {
    let object = await createObject(await newRoot(), 'changed-back', { 'a.txt': 'A' });
    object = await write(object, { 'a.txt': 'B' });
    object = await write(object, { 'a.txt': 'A' });
    assert.deepStrictEqual(datesOf(object.head.files.get('a.txt')!), { createdIn: 1, modifiedIn: 3 });
    assert.deepStrictEqual(datesOf(object.versions.get(2)!.files.get('a.txt')!), { createdIn: 1, modifiedIn: 2 });
  });

  it('gives the first version for a file no later version changed', async () => {
    let object = await createObject(await newRoot(), 'unchanged', { 'a.txt': 'a' });
    object = await write(object, { 'b.txt': 'b' });
    object = await write(object, { 'c.txt': 'c' });
    assert.deepStrictEqual(datesOf(object.head.files.get('a.txt')!), { createdIn: 1, modifiedIn: 1 });
    assert.deepStrictEqual(datesOf(object.head.files.get('b.txt')!), { createdIn: 2, modifiedIn: 2 });
  });

  it('creates a logical path again when it is removed and later added back', async () => {
    let object = await createObject(await newRoot(), 'added-back', { 'a.txt': 'a', 'b.txt': 'b' });
    object = await object.update(DETAILS, (draft) => draft.remove('a.txt'));
    object = await write(object, { 'a.txt': 'a' });
    assert.deepStrictEqual(datesOf(object.head.files.get('a.txt')!), { createdIn: 3, modifiedIn: 3 });
  });

  it('creates the new logical path of a renamed file', async () => {
    let object = await createObject(await newRoot(), 'renamed', { 'a.txt': 'a' });
    object = await object.update(DETAILS, (draft) => draft.rename('a.txt', 'b.txt'));
    assert.deepStrictEqual(datesOf(object.head.files.get('b.txt')!), { createdIn: 2, modifiedIn: 2 });
  });

  it('gives the same versions whichever version is read first', async () => {
    const root = await newRoot();
    let object = await createObject(root, 'read-order', { 'a.txt': 'a' });
    object = await write(object, { 'a.txt': 'b' });
    object = await write(object, { 'c.txt': 'c' });
    object = await write(object, { 'd.txt': 'd' });
    const opened = await root.open('read-order');
    const files = [3, 1, 4, 2].map((number) => opened.versions.get(number)!.files.get('a.txt')!);
    assert.deepStrictEqual(files.map(datesOf), [
      { createdIn: 1, modifiedIn: 2 },
      { createdIn: 1, modifiedIn: 1 },
      { createdIn: 1, modifiedIn: 2 },
      { createdIn: 1, modifiedIn: 2 },
    ]);
  });

  it('gives the versions of the object they were read from', async () => {
    let object = await createObject(await newRoot(), 'same-versions', { 'a.txt': 'a' });
    object = await write(object, { 'a.txt': 'b' });
    const file = object.head.files.get('a.txt')!;
    assert.strictEqual(file.createdIn, object.versions.get(1));
    assert.strictEqual(file.modifiedIn, object.versions.get(2));
    assert.strictEqual(file.createdAt, object.versions.get(1)!.createdAt);
    assert.strictEqual(file.modifiedAt, object.versions.get(2)!.createdAt);
  });

  it('takes no time from the stored file, even when it is replaced and touched', async () => {
    const root = await newRoot();
    await createObject(root, 'touched', { 'a.txt': 'a' });
    const stored = path.join(objectRootOf(root, 'touched'), 'v1', 'content', 'a.txt');
    await fs.promises.rm(stored);
    await fs.promises.writeFile(stored, 'a');
    const later = new Date('2030-01-01T00:00:00Z');
    await fs.promises.utimes(stored, later, later);
    const object = await root.open('touched');
    const file = object.head.files.get('a.txt')!;
    assert.deepStrictEqual(
      [file.createdIn, file.modifiedIn, file.createdAt, file.modifiedAt],
      [object.head, object.head, object.head.createdAt, object.head.createdAt],
    );
    assert.notStrictEqual(object.head.createdAt.getTime(), later.getTime());
  });

  it("doesn't list the files of any other version", async (t) => {
    let object = await createObject(await newRoot(), 'unlisted', { 'a.txt': 'a' });
    object = await write(object, { 'a.txt': 'b' });
    object = await write(object, { 'c.txt': 'c' });
    const head = object.head;
    const listed: number[] = [];
    const prototype = Object.getPrototypeOf(head);
    const files = Object.getOwnPropertyDescriptor(prototype, 'files')!.get!;
    t.mock.method(
      prototype,
      'files',
      function (this: Version) {
        listed.push(this.number);
        return files.call(this);
      },
      { getter: true },
    );
    const file = head.files.get('a.txt')!;
    assert.deepStrictEqual(datesOf(file), { createdIn: 1, modifiedIn: 2 });
    void [file.createdAt, file.modifiedAt];
    assert.deepStrictEqual(listed, [3]);
  });

  it("doesn't count a digest spelt in another case by an earlier version as a change", async () => {
    const root = await newRoot();
    let object = await createObject(root, 'digest-case', { 'a.txt': 'a' });
    object = await write(object, { 'b.txt': 'b' });
    const objectRoot = objectRootOf(root, 'digest-case');
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
    });
    const opened = await root.open('digest-case');
    assert.deepStrictEqual(datesOf(opened.head.files.get('a.txt')!), { createdIn: 1, modifiedIn: 1 });
  });
});

const datesOf = (file: OcflFile) => ({ createdIn: file.createdIn.number, modifiedIn: file.modifiedIn.number });

function write(object: OcflObject, files: Record<string, string>): Promise<OcflObject> {
  return object.update(DETAILS, async (draft) => {
    for (const [logicalPath, content] of Object.entries(files)) {
      await draft.write(logicalPath, content);
    }
  });
}
