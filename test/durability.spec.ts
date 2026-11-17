import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { type OcflObject, openStorageRoot } from '../src/index.ts';
import { DETAILS, objectAtV1, recover, sidecarMatches, snapshot, useTempRoots, writeB, writeC } from './helpers/drafts.ts';
import { flushedDuring, flushedFrom } from './helpers/flushes.ts';
import { beforeRenamingTo, withFsFailure } from './helpers/fs-failures.ts';
import { HASHED } from './helpers/layouts.ts';
import { rejection } from './helpers/ocfl-error.ts';

const ID = 'durable';
const WORKSPACE = path.join('extensions', 'ocfl-js-workspace');
const VERSION_IN_WORKSPACE = path.join(WORKSPACE, ID, 'v2');

const unique = (paths: string[]) => [...new Set(paths)].sort();

describe('durability', () => {
  const { newRoot } = useTempRoots('ocfl-durability-');
  afterEach(() => {
    mock.restoreAll();
  });

  describe("with the default, 'full'", () => {
    it("flushes the lock's name, and every file and directory of an updated version, before its commit point, and the object root after it", async () => {
      const { root, object, objectRoot } = await objectAtV1(await newRoot(), ID);
      let beforeCommit: string[] = [];
      const flushed = await flushedDuring((soFar) =>
        beforeRenamingTo(
          path.join(objectRoot, 'inventory.json'),
          async () => {
            beforeCommit = [...soFar];
          },
          () => object.update(DETAILS, (draft) => draft.write('dir/b.txt', 'b')),
        ),
      );

      assert.deepStrictEqual(
        unique(flushedFrom(root.path, beforeCommit)),
        unique([
          '',
          'extensions',
          WORKSPACE,
          path.join(WORKSPACE, ID),
          ID,
          path.join(ID, 'inventory.json.sha512.tmp'),
          path.join(ID, 'inventory.json.tmp'),
          VERSION_IN_WORKSPACE,
          path.join(VERSION_IN_WORKSPACE, 'content'),
          path.join(VERSION_IN_WORKSPACE, 'content', 'dir'),
          path.join(VERSION_IN_WORKSPACE, 'content', 'dir', 'b.txt'),
          path.join(VERSION_IN_WORKSPACE, 'inventory.json'),
          path.join(VERSION_IN_WORKSPACE, 'inventory.json.sha512'),
        ]),
      );
      assert.deepStrictEqual(flushedFrom(root.path, flushed.slice(beforeCommit.length)), [ID]);
    });

    it('discards an update when flushing its version fails, with that failure, leaving the object as it was and unlocked', async () => {
      const { root, object, objectRoot, lock, before } = await objectAtV1(await newRoot(), ID);
      const storedFile = path.join(root.path, VERSION_IN_WORKSPACE, 'content', 'b.txt');

      await assert.rejects(
        withFsFailure('open', storedFile, () => object.update(DETAILS, writeB)),
        /injected failure/,
      );

      assert.deepStrictEqual(await snapshot(objectRoot), before);
      assert.ok(!fs.existsSync(lock));
      assert.ok(!fs.existsSync(path.join(root.path, VERSION_IN_WORKSPACE)));
    });

    it('flushes the version, root inventory and declaration of a created object, and each directory from its object root up to the storage root', async () => {
      const root = await newRoot({ extensionName: HASHED });

      const flushed = flushedFrom(root.path, await flushedDuring(() => root.create(ID, DETAILS, writeB)));

      const declaration = (await fs.promises.readdir(root.path, { recursive: true })).find((file) => file.endsWith('0=ocfl_object_1.1'));
      assert.ok(declaration);
      const objectRoot = path.dirname(declaration);
      assert.strictEqual(objectRoot.split(path.sep).length, 4);
      const directories = [''];
      for (let dir = objectRoot; dir !== '.'; dir = path.dirname(dir)) {
        directories.push(dir);
      }
      const version = path.join(WORKSPACE, objectRoot, 'v1');
      const inVersion = ['', 'content', path.join('content', 'b.txt'), 'inventory.json', 'inventory.json.sha512'].map((name) => path.join(version, name));
      const rootInventory = ['inventory.json.tmp', 'inventory.json.sha512.tmp'].map((name) => path.join(objectRoot, name));
      for (const flushedPath of [declaration, ...directories, ...inVersion, ...rootInventory]) {
        assert.ok(flushed.includes(flushedPath), `${flushedPath} was not flushed`);
      }
    });

    it('flushes the sidecar that recovering a committed update writes, and the object root', async () => {
      const { root, object, objectRoot } = await objectAtV1(await newRoot(), ID);
      await rejection(
        withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => object.update(DETAILS, writeB)),
        'RECOVERY_NEEDED',
      );

      const flushed = await flushedDuring(() => recover(root, ID));

      assert.deepStrictEqual(flushedFrom(root.path, flushed), [path.join(ID, 'inventory.json.sha512.tmp'), ID]);
      assert.ok(await sidecarMatches(objectRoot));
    });

    it('flushes the object root when recovering a committed update whose sidecar is already in place', async () => {
      const { root, object, lock } = await objectAtV1(await newRoot(), ID);
      await rejection(
        withFsFailure('rm', lock, () => object.update(DETAILS, writeB)),
        'RECOVERY_NEEDED',
      );

      const flushed = await flushedDuring(() => recover(root, ID));

      assert.deepStrictEqual(flushedFrom(root.path, flushed), [ID]);
    });

    it('flushes what discarding an update removed from the object root before releasing the lock', async () => {
      const { root, object, objectRoot, lock } = await objectAtV1(await newRoot(), ID);
      let failedAt = 0;
      let flushedBeforeRelease: string[] = [];
      await flushedDuring(async (soFar) => {
        const realRename = fs.promises.rename;
        mock.method(fs.promises, 'rename', async (...args: Parameters<typeof realRename>) => {
          if (String(args[1]) === path.join(objectRoot, 'inventory.json')) {
            failedAt = soFar.length;
            throw Object.assign(new Error('injected failure'), { code: 'EIO' });
          }
          return realRename.apply(fs.promises, args);
        });
        const realRm = fs.promises.rm;
        mock.method(fs.promises, 'rm', async (...args: Parameters<typeof realRm>) => {
          if (String(args[0]) === lock) {
            flushedBeforeRelease = flushedFrom(root.path, soFar.slice(failedAt));
          }
          return realRm.apply(fs.promises, args);
        });
        await assert.rejects(object.update(DETAILS, writeB), /injected failure/);
      });

      assert.deepStrictEqual(flushedBeforeRelease, [ID]);
      assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
    });

    it('flushes the storage root when recovering a create that died, once its object root is removed', async () => {
      const root = await newRoot();
      await rejection(
        withFsFailure('rename', path.join(root.path, ID, 'inventory.json.sha512'), () => root.create(ID, DETAILS, writeB)),
        'RECOVERY_NEEDED',
      );
      await fs.promises.rm(path.join(root.path, ID, 'inventory.json'));

      const flushed = await flushedDuring(() => recover(root, ID));

      assert.deepStrictEqual(flushedFrom(root.path, flushed), ['']);
      assert.ok(!fs.existsSync(path.join(root.path, ID)));
    });
  });

  describe("with 'none'", () => {
    /** The storage root at `rootPath`, opened with durability `'none'` */
    const undurable = (rootPath: string) => openStorageRoot(rootPath, { durability: 'none' });

    it('flushes nothing but the lock in a create', async () => {
      const root = await undurable((await newRoot()).path);
      assert.deepStrictEqual(flushedFrom(root.path, await flushedDuring(() => root.create(ID, DETAILS, writeB))), []);
    });

    it('flushes nothing but the lock in an update of an object opened or listed through the storage root', async () => {
      const root = await undurable((await objectAtV1(await newRoot(), ID)).root.path);
      const listed: OcflObject[] = [];
      for await (const entry of root.objects()) {
        assert.ok('object' in entry);
        listed.push(entry.object);
      }
      assert.strictEqual(listed.length, 1);

      const flushed = await flushedDuring(async () => {
        const updated = await (listed[0] as OcflObject).update(DETAILS, writeB);
        await updated.update(DETAILS, writeC);
        await (await root.open(ID)).update(DETAILS, (draft) => draft.write('d.txt', 'd'));
      });

      assert.deepStrictEqual(flushedFrom(root.path, flushed), []);
      assert.strictEqual((await root.open(ID)).head.number, 4);
    });

    it('flushes nothing when recovering a committed update', async () => {
      const { root: made, object, objectRoot } = await objectAtV1(await newRoot(), ID);
      const root = await undurable(made.path);
      await rejection(
        withFsFailure('rename', path.join(objectRoot, 'inventory.json.sha512'), () => object.update(DETAILS, writeB)),
        'RECOVERY_NEEDED',
      );

      const flushed = await flushedDuring(async () => {
        for await (const write of root.unfinishedWrites()) {
          await write.recover();
        }
      });

      assert.deepStrictEqual(flushedFrom(root.path, flushed), []);
      assert.ok(await sidecarMatches(objectRoot));
    });
  });
});
