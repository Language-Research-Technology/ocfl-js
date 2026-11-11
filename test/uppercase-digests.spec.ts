import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DETAILS, objectRootOf, readInventory, sha512, textFiles, useTempRoots } from './helpers/drafts.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { rewriteInventory, upperCased, writeForeignObject } from './helpers/storage-roots.ts';

describe('digests written in uppercase by another tool', () => {
  const { newRoot } = useTempRoots('ocfl-uppercase-digests-');

  it('opens an object whose sidecar records the inventory digest in uppercase', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'upper-sidecar');
    await writeForeignObject(objectRoot, 'upper-sidecar', { 'a.txt': 'a' }, { digestAlgorithm: 'sha512' });
    for (const dir of [objectRoot, path.join(objectRoot, 'v1')]) {
      const sidecar = path.join(dir, 'inventory.json.sha512');
      await fs.promises.writeFile(sidecar, (await fs.promises.readFile(sidecar, 'utf8')).toUpperCase().replace('INVENTORY.JSON', 'inventory.json'));
    }

    const object = await root.open('upper-sidecar');

    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'a' });
  });

  it('opens an object mid-commit, when its head version sidecar records the digest in uppercase', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'upper-head-sidecar');
    await writeForeignObject(objectRoot, 'upper-head-sidecar', { 'a.txt': 'a' }, { digestAlgorithm: 'sha512' });
    const headSidecar = path.join(objectRoot, 'v1', 'inventory.json.sha512');
    await fs.promises.writeFile(
      headSidecar,
      `${sha512(await fs.promises.readFile(path.join(objectRoot, 'v1', 'inventory.json'))).toUpperCase()} inventory.json\n`,
    );
    await fs.promises.writeFile(path.join(objectRoot, 'inventory.json.sha512'), `${sha512('an earlier inventory')} inventory.json\n`);

    assert.deepStrictEqual(await textFiles((await root.open('upper-head-sidecar')).head), { 'a.txt': 'a' });
  });

  it('refuses an object whose manifest has one digest twice, in different cases', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'duplicate-digest');
    await writeForeignObject(objectRoot, 'duplicate-digest', { 'a.txt': 'a' }, { digestAlgorithm: 'sha512' });
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest = { ...inventory.manifest, [sha512('a').toUpperCase()]: ['v1/content/a.txt'] };
    });

    await assert.rejects(root.open('duplicate-digest'), ocflError('INVALID_OBJECT', 'E096'));
  });

  it('opens an object whose manifest spells a digest in uppercase and its state in lowercase, and reads its files', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'upper-manifest');
    await writeForeignObject(objectRoot, 'upper-manifest', { 'a.txt': 'a', 'b.txt': 'b' }, { digestAlgorithm: 'sha512' });
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest = upperCased(inventory.manifest!);
    });

    assert.deepStrictEqual(await textFiles((await root.open('upper-manifest')).head), { 'a.txt': 'a', 'b.txt': 'b' });
  });

  it('opens an object whose state spells a digest in uppercase and its manifest in lowercase, and reads its files', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'upper-state');
    await writeForeignObject(objectRoot, 'upper-state', { 'a.txt': 'a', 'b.txt': 'b' }, { digestAlgorithm: 'sha512' });
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
    });

    assert.deepStrictEqual(await textFiles((await root.open('upper-state')).head), { 'a.txt': 'a', 'b.txt': 'b' });
  });

  it('gives the digest of a file in lowercase, whatever case the inventory spells it in', async () => {
    const root = await newRoot();
    const objectRoot = objectRootOf(root, 'lowercase-file-digest');
    await writeForeignObject(objectRoot, 'lowercase-file-digest', { 'a.txt': 'a' }, { digestAlgorithm: 'sha512' });
    await rewriteInventory(objectRoot, (inventory) => {
      inventory.manifest = upperCased(inventory.manifest!);
      inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
    });

    assert.strictEqual((await root.open('lowercase-file-digest')).head.files.get('a.txt')!.digest, sha512('a'));
  });

  describe('updating an object whose state and manifest spell digests in different cases', () => {
    async function updateMixedCaseObject(id: string, upper: 'manifest' | 'state' = 'manifest') {
      const root = await newRoot();
      const objectRoot = objectRootOf(root, id);
      await writeForeignObject(objectRoot, id, { 'a.txt': 'a', 'b.txt': 'b' }, { digestAlgorithm: 'sha512' });
      await rewriteInventory(objectRoot, (inventory) => {
        if (upper === 'manifest') {
          inventory.manifest = upperCased(inventory.manifest!);
        } else {
          inventory.versions!.v1!.state = upperCased(inventory.versions!.v1!.state);
        }
      });
      const v1 = (await readInventory(objectRoot)).versions.v1;
      const updated = await (await root.open(id)).update(DETAILS, async (draft) => {
        await draft.write('copy-of-a.txt', 'a');
        await draft.write('c.txt', 'c');
        await draft.remove('b.txt');
      });
      return { root, updated, v1, inventory: await readInventory(objectRoot) };
    }

    it('adds no second manifest key for content the manifest has in another case', async () => {
      const { inventory } = await updateMixedCaseObject('no-second-key');

      assert.deepStrictEqual(Object.keys(inventory.manifest).sort(), [sha512('a').toUpperCase(), sha512('b').toUpperCase(), sha512('c')].sort());
    });

    it("spells the new version's state with the manifest's keys, and new digests in lowercase", async () => {
      const { inventory, v1 } = await updateMixedCaseObject('state-spelling');

      assert.deepStrictEqual(inventory.versions.v2!.state, { [sha512('a').toUpperCase()]: ['a.txt', 'copy-of-a.txt'], [sha512('c')]: ['c.txt'] });
      assert.deepStrictEqual(inventory.versions.v1, v1);
    });

    it("respells an uppercase state with the manifest's lowercase keys", async () => {
      const { inventory, v1 } = await updateMixedCaseObject('upper-state-update', 'state');

      assert.deepStrictEqual(Object.keys(inventory.manifest).sort(), [sha512('a'), sha512('b'), sha512('c')].sort());
      assert.deepStrictEqual(inventory.versions.v2!.state, { [sha512('a')]: ['a.txt', 'copy-of-a.txt'], [sha512('c')]: ['c.txt'] });
      assert.deepStrictEqual(inventory.versions.v1, v1);
    });

    it('reads the updated object', async () => {
      const { root, updated } = await updateMixedCaseObject('reads-updated');

      const expected = { 'a.txt': 'a', 'copy-of-a.txt': 'a', 'c.txt': 'c' };
      assert.deepStrictEqual(await textFiles(updated.head), expected);
      assert.deepStrictEqual(await textFiles((await root.open('reads-updated')).head), expected);
      assert.deepStrictEqual(await updated.checkFixity(), []);
    });
  });
});
