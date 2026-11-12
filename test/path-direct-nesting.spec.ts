import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { LayoutConfig, StorageRoot } from '../src/index.ts';
import { createObject, DETAILS, snapshot, textFiles, useTempRoots } from './helpers/drafts.ts';
import { PATH_DIRECT } from './helpers/layouts.ts';
import { ocflError } from './helpers/ocfl-error.ts';

const incompatible = ocflError('ID_INCOMPATIBLE_WITH_LAYOUT');

/** Every directory and file under `dir`, with the content of each file */
async function everything(dir: string) {
  return { paths: (await fs.promises.readdir(dir, { recursive: true })).sort(), files: await snapshot(dir) };
}

describe('a path-direct id whose path has the suffix part-way through', () => {
  const temp = useTempRoots('ocfl-path-direct-nesting-');

  const configs: [string, LayoutConfig, string[]][] = [
    ['the default suffix', { extensionName: PATH_DIRECT }, ['outer/__object__/inner', 'outer/__object__/v1', 'outer/__object__/lock', 'outer/__object__/']],
    ['a custom suffix', { extensionName: PATH_DIRECT, suffix: '.obj' }, ['outer/.obj/inner', 'outer/.obj/v1', 'outer/.obj/']],
    ['a replace rule', { extensionName: PATH_DIRECT, suffix: '.obj', replace: [['OBJ', '.obj']] }, ['outer/OBJ/inner']],
  ];

  for (const [how, layout, ids] of configs) {
    describe(`reached through ${how}`, () => {
      const operations: [string, (root: StorageRoot, id: string) => Promise<unknown>][] = [
        ['create', (root, id) => createObject(root, id, { 'b.txt': 'b' })],
        ['open', (root, id) => root.open(id)],
        ['remove', (root, id) => root.remove(id)],
        ['recover', (root, id) => root.recover(id)],
      ];
      for (const [name, operation] of operations) {
        for (const id of ids) {
          it(`${name} throws ID_INCOMPATIBLE_WITH_LAYOUT for <${id}>, touching nothing`, async () => {
            const root = await temp.newRoot(layout);
            await createObject(root, 'outer', { 'a.txt': 'a' });
            const before = await everything(path.dirname(root.path));

            await assert.rejects(operation(root, id), incompatible);

            assert.deepStrictEqual(await everything(path.dirname(root.path)), before);
          });
        }
      }
    });
  }

  it('is refused while the object it would be inside is being created, which then commits', async () => {
    const root = await temp.newRoot({ extensionName: PATH_DIRECT });
    const outer = await root.create('outer', DETAILS, async (draft) => {
      await draft.write('a.txt', 'a');
      await assert.rejects(createObject(root, 'outer/__object__/inner', { 'b.txt': 'b' }), incompatible);
    });
    assert.deepStrictEqual(await textFiles(outer.head), { 'a.txt': 'a' });
    assert.deepStrictEqual(await textFiles((await root.open('outer')).head), { 'a.txt': 'a' });
  });

  it('leaves ids that only start with another id to create side by side', async () => {
    const root = await temp.newRoot({ extensionName: PATH_DIRECT });
    await createObject(root, 'a', { 'a.txt': 'a' });
    await createObject(root, 'a/b', { 'b.txt': 'b' });
    assert.deepStrictEqual(await textFiles((await root.open('a')).head), { 'a.txt': 'a' });
    assert.deepStrictEqual(await textFiles((await root.open('a/b')).head), { 'b.txt': 'b' });
  });
});
