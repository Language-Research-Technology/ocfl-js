import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openStorageRoot } from '../src/index.ts';
import { useTempRoots } from './helpers/drafts.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { fixtureObjects, writeFixtureRoot } from './helpers/storage-roots.ts';

/** The manifest's content path for `digest`, compared without regard to case as OCFL digests are */
function contentPathOf(manifest: Record<string, string[]>, digest: string): string {
  const key = Object.keys(manifest).find((d) => d.toLowerCase() === digest.toLowerCase());
  assert.ok(key, `no manifest entry for ${digest}`);
  return manifest[key]![0]!;
}

describe('the official OCFL fixtures', () => {
  const temp = useTempRoots('ocfl-official-fixtures-');

  async function rootHolding(name: string, dir: string, id: string) {
    const root = path.join(temp.dir, name);
    await writeFixtureRoot(root, dir, id);
    return openStorageRoot(root);
  }

  describe('good objects', () => {
    for (const { name, dir, inventory } of fixtureObjects('good-objects')) {
      it(`reads ${name} as its inventory describes it`, async () => {
        const { id, digestAlgorithm, manifest, versions } = inventory as Required<typeof inventory>;
        const object = await (await rootHolding(name, dir, id)).open(id);
        assert.strictEqual(object.id, id);
        assert.strictEqual(object.digestAlgorithm, digestAlgorithm);
        assert.deepStrictEqual(
          [...object.versions.keys()],
          Object.keys(versions).map((v) => Number(v.slice(1))),
        );
        for (const [versionName, expected] of Object.entries(versions)) {
          const version = object.versions.get(Number(versionName.slice(1)))!;
          assert.strictEqual(version.message, expected.message);
          assert.deepStrictEqual(version.user, expected.user);
          const logicalPaths = Object.values(expected.state).flat().sort();
          assert.deepStrictEqual([...version.files.keys()].sort(), logicalPaths, versionName);
          for (const [digest, paths] of Object.entries(expected.state)) {
            const stored = await fs.promises.readFile(path.join(dir, contentPathOf(manifest, digest)));
            for (const logicalPath of paths) {
              const file = version.files.get(logicalPath)!;
              assert.strictEqual(file.digest.toLowerCase(), digest.toLowerCase(), logicalPath);
              assert.deepStrictEqual(Buffer.from(await file.bytes()), stored, logicalPath);
            }
          }
        }
        assert.deepStrictEqual((await object.checkFixity()).problems, []);
      });
    }
  });

  describe('bad objects', () => {
    for (const { name, dir, inventory } of fixtureObjects('bad-objects')) {
      // Named for the codes they break, as in E049_E050_E054_bad_version_block_values
      const codes = name.match(/^(?:E\d{3}_)+/)![0].match(/E\d{3}/g)!;

      it(`refuses ${name} with ${codes.join(' or ')}`, async () => {
        const isRefusal = (e: unknown) => codes.some((code) => ocflError('INVALID_OBJECT', code)(e));
        const root = await rootHolding(name, dir, inventory.id ?? name);
        const listed = [];
        for await (const entry of root.objects()) {
          listed.push(entry);
        }
        assert.strictEqual(listed.length, 1);
        assert.ok(listed[0]?.status === 'damaged' && isRefusal(listed[0].error), `listed as ${JSON.stringify(listed[0])}`);
        if (typeof inventory.id === 'string') {
          await assert.rejects(root.open(inventory.id), isRefusal);
        }
      });
    }
  });
});
