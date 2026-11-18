import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { type Draft, isOcflError } from '../src/index.ts';
import { DETAILS, lockObject, objectAtV1, textFiles, useTempRoots, writeC } from './helpers/drafts.ts';
import { beforeOpening } from './helpers/fs-failures.ts';
import { ocflError } from './helpers/ocfl-error.ts';
import { moveHead } from './helpers/storage-roots.ts';

const ID = 'deposited';

describe('root.createOrUpdate', () => {
  const { newRoot } = useTempRoots('ocfl-create-or-update-');
  afterEach(() => {
    mock.restoreAll();
  });

  it('creates an absent object with what build makes as v1', async () => {
    const root = await newRoot();

    const object = await root.createOrUpdate(ID, DETAILS, writeC);

    assert.strictEqual(object.head.number, 1);
    assert.deepStrictEqual(await textFiles(object.head), { 'c.txt': 'c' });
    assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'c.txt': 'c' });
  });

  it("adds a version to an object that exists, from a draft that starts with the head's files", async () => {
    const { root } = await objectAtV1(await newRoot(), ID);

    const object = await root.createOrUpdate(ID, DETAILS, writeC);

    assert.strictEqual(object.head.number, 2);
    assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'a', 'c.txt': 'c' });
  });

  it('replaces the head files when build clears the draft first', async () => {
    const { root } = await objectAtV1(await newRoot(), ID);

    const object = await root.createOrUpdate(ID, DETAILS, async (draft) => {
      await draft.clear();
      await writeC(draft);
    });

    assert.strictEqual(object.head.number, 2);
    assert.deepStrictEqual(await textFiles(object.head), { 'c.txt': 'c' });
  });

  it('refuses an option create has not, naming createOrUpdate, and writes nothing', async () => {
    const root = await newRoot();

    await assert.rejects(
      root.createOrUpdate(ID, { ...DETAILS, attempts: 5 } as never, writeC),
      (error) => error instanceof TypeError && /root\.createOrUpdate has no option/.test(error.message),
    );
    assert.strictEqual(await root.has(ID), false);
  });

  it('throws what build throws when creating, without starting again, and leaves no object', async () => {
    const root = await newRoot();
    const failure = new Error('build failed');
    const build = mock.fn(async () => {
      throw failure;
    });

    await assert.rejects(root.createOrUpdate(ID, DETAILS, build), (error) => error === failure);
    assert.strictEqual(build.mock.callCount(), 1);
    assert.strictEqual(await root.has(ID), false);
  });

  it('throws OBJECT_EXISTS from build about another object, without starting again', async () => {
    const root = await newRoot();
    await objectAtV1(root, 'other');
    const build = mock.fn((draft: Draft) => root.create('other', DETAILS, () => writeC(draft)));

    await assert.rejects(root.createOrUpdate(ID, DETAILS, build), (error) => isOcflError(error, 'OBJECT_EXISTS') && error.objectId === 'other');
    assert.strictEqual(build.mock.callCount(), 1);
    assert.strictEqual(await root.has(ID), false);
  });

  it('throws OBJECT_NOT_FOUND from build about another object, without starting again', async () => {
    const { root } = await objectAtV1(await newRoot(), ID);
    const build = mock.fn(async () => {
      await root.open('missing');
    });

    await assert.rejects(root.createOrUpdate(ID, DETAILS, build), (error) => isOcflError(error, 'OBJECT_NOT_FOUND') && error.objectId === 'missing');
    assert.strictEqual(build.mock.callCount(), 1);
  });

  it('refuses a signal already aborted before build runs', async () => {
    const root = await newRoot();
    const reason = new Error('stopped');
    const build = mock.fn(writeC);

    await assert.rejects(root.createOrUpdate(ID, { ...DETAILS, signal: AbortSignal.abort(reason) }, build), (error) => error === reason);
    assert.strictEqual(build.mock.callCount(), 0);
    assert.strictEqual(await root.has(ID), false);
  });

  it('refuses a signal already aborted before placing the id, as create does', async () => {
    const root = await newRoot();
    const reason = new Error('stopped');
    const tooLong = 'x'.repeat(300);

    await assert.rejects(root.createOrUpdate(tooLong, { ...DETAILS, signal: AbortSignal.abort(reason) }, writeC), (error) => error === reason);
    await assert.rejects(root.createOrUpdate(tooLong, DETAILS, writeC), ocflError('ID_INCOMPATIBLE_WITH_LAYOUT'));
  });

  it('commits no version when the draft ends the same as the head', async () => {
    const { root, objectRoot } = await objectAtV1(await newRoot(), ID);

    const object = await root.createOrUpdate(ID, DETAILS, (draft) => draft.write('a.txt', 'a'));

    assert.strictEqual(object.head.number, 1);
    assert.ok(!fs.existsSync(path.join(objectRoot, 'v2')));
  });

  describe('when another writer gets between the steps', () => {
    it('starts again from the create when a version is committed between the open and the update, and builds again', async () => {
      const { root, objectRoot } = await objectAtV1(await newRoot(), ID);
      const build = mock.fn(writeC);
      build.mock.mockImplementationOnce(async (draft: Draft) => {
        await writeC(draft);
        await moveHead(objectRoot);
      });

      const object = await root.createOrUpdate(ID, DETAILS, build);

      assert.strictEqual(build.mock.callCount(), 2);
      assert.strictEqual(object.head.number, 3);
      assert.deepStrictEqual(await textFiles(object.head), { 'a.txt': 'a', 'c.txt': 'c' });
    });

    it('starts again from the create when the object is purged between the create and the open', async () => {
      const { root, objectRoot } = await objectAtV1(await newRoot(), ID);
      const build = mock.fn(writeC);

      const object = await beforeOpening(
        path.join(objectRoot, 'inventory.json'),
        () => root.purge(ID),
        () => root.createOrUpdate(ID, DETAILS, build),
      );

      assert.strictEqual(build.mock.callCount(), 1);
      assert.strictEqual(object.head.number, 1);
      assert.deepStrictEqual(await textFiles(object.head), { 'c.txt': 'c' });
    });

    it('throws the last OBJECT_OUT_OF_DATE after three attempts', async () => {
      const { root, objectRoot } = await objectAtV1(await newRoot(), ID);
      const build = mock.fn(async (draft: Draft) => {
        await writeC(draft);
        await moveHead(objectRoot);
      });

      await assert.rejects(root.createOrUpdate(ID, DETAILS, build), ocflError('OBJECT_OUT_OF_DATE'));
      assert.strictEqual(build.mock.callCount(), 3);
    });

    it('throws OBJECT_LOCKED from the first attempt, without trying the lock again', async () => {
      const { root } = await objectAtV1(await newRoot(), ID);
      const lock = await lockObject(root, ID);
      const links = mock.method(fs.promises, 'link');
      const build = mock.fn(writeC);

      await assert.rejects(root.createOrUpdate(ID, DETAILS, build), ocflError('OBJECT_LOCKED'));
      assert.strictEqual(links.mock.calls.filter((call) => String(call.arguments[1]) === lock).length, 1);
      assert.strictEqual(build.mock.callCount(), 0);
    });

    it('throws the abort reason, not OBJECT_OUT_OF_DATE, when the signal is aborted during an attempt that raced', async () => {
      const { root, objectRoot } = await objectAtV1(await newRoot(), ID);
      const controller = new AbortController();
      const reason = new Error('stopped');
      const build = mock.fn(async (draft: Draft) => {
        await writeC(draft);
        await moveHead(objectRoot);
        controller.abort(reason);
      });

      await assert.rejects(root.createOrUpdate(ID, { ...DETAILS, signal: controller.signal }, build), (error) => error === reason);
      assert.strictEqual(build.mock.callCount(), 1);
    });
  });
});
