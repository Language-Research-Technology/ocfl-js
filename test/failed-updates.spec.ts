import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import type { Draft, OcflObject, StorageRoot, WriteContent } from '../src/index.ts';
import { emptyDirectoriesUnder } from './empty-directories.ts';
import { mountSeparately, withFsFailure } from './fs-failures.ts';
import {
  assertVersionValid,
  createObject,
  DETAILS,
  FLAT,
  objectRootOf,
  snapshot,
  storedFiles,
  textFiles,
  useTempRoots,
  workspaceOf,
} from './helpers/drafts.ts';
import { HASHED, PATH_DIRECT } from './helpers/layouts.ts';
import { ocflError } from './ocfl-error.ts';

type Change = (draft: Draft) => Promise<void>;
/** Starts a `create` or an `update` with the callback it is given */
type Run = (change: Change) => Promise<OcflObject>;

const ID = 'scoped';
const NEW_ROOT_ENTRIES = ['0=ocfl_1.1', 'ocfl-js-workspace.md', 'ocfl_1.1.md', 'ocfl_layout.json'];

const writeB: Change = (draft) => draft.write('b.txt', 'b');
const isUnfinished = (e: unknown) => e instanceof Error && e.message.startsWith('Unfinished operations detected');
const isFinishedDraft = (e: unknown) => e instanceof Error && !(e instanceof TypeError) && /draft/.test(e.message) && /finished/.test(e.message);

async function throwing(run: Run): Promise<void> {
  const failure = new Error('callback failed');
  await assert.rejects(
    run(async (draft) => {
      await writeB(draft);
      throw failure;
    }),
    (e) => e === failure,
  );
}

/** Ways an update ends without committing, each asserting how it is reported */
const endings: [string, (run: Run) => Promise<void>][] = [
  ['a throwing callback', throwing],
  [
    'a callback that is not async',
    (run) =>
      assert.rejects(
        run(((draft: Draft) => {
          draft.write('floating.txt', 'floating');
        }) as unknown as Change),
        isUnfinished,
      ),
  ],
  [
    'a callback that does not await an operation',
    (run) =>
      assert.rejects(
        run(async (draft) => {
          draft.write('floating.txt', 'floating');
        }),
        isUnfinished,
      ),
  ],
];

/** The steps of a commit before the root inventory is replaced, as the file system call each one makes */
const commitSteps: { step: string; method: 'rename' | 'copyFile' | 'writeFile'; target: (objectRoot: string, workspace: string, version: string) => string }[] =
  [
    { step: 'writing the version inventory', method: 'writeFile', target: (_, workspace, v) => path.join(workspace, v, 'inventory.json') },
    { step: 'moving the version into the object', method: 'rename', target: (objectRoot, _, v) => path.join(objectRoot, v) },
    { step: 'staging the root inventory', method: 'copyFile', target: (objectRoot) => path.join(objectRoot, 'inventory.json.tmp') },
    { step: 'staging the root inventory sidecar', method: 'copyFile', target: (objectRoot) => path.join(objectRoot, 'inventory.json.sha512.tmp') },
  ];

const failingPartway: [string, () => WriteContent][] = [
  [
    'an async generator',
    async function* () {
      yield 'partial';
      throw new Error('source failed');
    },
  ],
  [
    'a web ReadableStream',
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
        },
        pull(controller) {
          controller.error(new Error('source failed'));
        },
      }),
  ],
  [
    'a Node Readable',
    () =>
      new Readable({
        read() {
          this.push('partial');
          this.destroy(new Error('source failed'));
        },
      }),
  ],
  [
    'a stream that fails before its first chunk',
    () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('source failed'));
        },
      }),
  ],
];

describe('an update that fails or finishes early', () => {
  const temp = useTempRoots('ocfl-failed-updates-');
  const { newRoot } = temp;
  afterEach(() => {
    mock.restoreAll();
  });

  const creating =
    (root: StorageRoot): Run =>
    (change) =>
      root.create(ID, DETAILS, change);
  const updating =
    (object: OcflObject): Run =>
    (change) =>
      object.update(DETAILS, change);
  const assertNoExtensions = (root: StorageRoot) => assert.ok(!fs.existsSync(path.join(root.path, 'extensions')));

  /** A storage root holding the object {@link ID} at v1, and what it looks like on disk */
  async function existingObject() {
    const root = await newRoot();
    const object = await createObject(root, ID, { 'a.txt': 'a' });
    const objectRoot = objectRootOf(root, ID);
    return { root, object, objectRoot, before: await snapshot(objectRoot) };
  }

  /** The object is at v1 on disk, as the object the update was called on and as opened afresh, with nothing left over */
  async function assertStillAtV1({ root, object, objectRoot, before }: Awaited<ReturnType<typeof existingObject>>) {
    assert.deepStrictEqual(await snapshot(objectRoot), before);
    assertNoExtensions(root);
    for (const o of [object, await root.open(ID)]) {
      assert.strictEqual(o.head.number, 1);
      assert.deepStrictEqual([...o.versions.keys()], [1]);
      assert.deepStrictEqual(await textFiles(o.head), { 'a.txt': 'a' });
    }
  }

  /** Nothing of the object {@link ID} exists, and it can still be created */
  async function assertNoPartialObject(root: StorageRoot) {
    assert.ok(!fs.existsSync(objectRootOf(root, ID)));
    assertNoExtensions(root);
    assert.deepStrictEqual((await fs.promises.readdir(root.path)).sort(), NEW_ROOT_ENTRIES);
    await assert.rejects(root.open(ID), ocflError('OBJECT_NOT_FOUND'));
    const created = await root.create(ID, DETAILS, writeB);
    assert.deepStrictEqual(await textFiles(created.head), { 'b.txt': 'b' });
  }

  describe('without committing', () => {
    for (const [name, end] of endings) {
      it(`leaves an existing object intact after ${name}`, async () => {
        const existing = await existingObject();
        await end(updating(existing.object));
        await assertStillAtV1(existing);
      });

      it(`leaves no partial object after ${name} on a new object`, async () => {
        const root = await newRoot();
        await end(creating(root));
        await assertNoPartialObject(root);
      });

      it(`keeps an object root that already existed after ${name}`, async () => {
        const root = await newRoot();
        const objectRoot = objectRootOf(root, ID);
        await fs.promises.mkdir(objectRoot);

        await end(creating(root));

        assert.deepStrictEqual(await fs.promises.readdir(objectRoot), []);
        assertNoExtensions(root);
        const created = await root.create(ID, DETAILS, writeB);
        assert.deepStrictEqual(await textFiles(created.head), { 'b.txt': 'b' });
      });
    }

    it('leaves an existing object intact after an update that changes nothing', async () => {
      const existing = await existingObject();
      const returned = await existing.object.update(DETAILS, async (draft) => {
        await draft.write('a.txt', 'a');
      });
      assert.strictEqual(returned, existing.object);
      await assertStillAtV1(existing);
    });

    it('removes what the callback wrote to the workspace before it threw', async () => {
      const root = await newRoot();
      const failure = new Error('callback failed');
      await assert.rejects(
        root.create(ID, DETAILS, async (draft) => {
          await draft.write('test.txt', 'test');
          assert.ok(fs.existsSync(path.join(workspaceOf(root), ID, 'v1')));
          throw failure;
        }),
        (e) => e === failure,
      );
      await assertNoPartialObject(root);
    });

    it("reports the callback's own error when an earlier operation failed", async () => {
      const root = await newRoot();
      const failure = new Error('callback failed');
      await assert.rejects(
        root.create(ID, DETAILS, async (draft) => {
          await draft.write('a.txt', 'a');
          await draft.write('../escape.txt', 'x').catch(() => {});
          throw failure;
        }),
        (e) => e === failure,
      );
      await assertNoPartialObject(root);
    });

    it('fails a create whose place lies below a plain file, leaving the file as it was', async () => {
      const root = await newRoot({ extensionName: PATH_DIRECT, suffix: '' });
      await fs.promises.writeFile(path.join(root.path, 'a-file'), 'not an object');

      await assert.rejects(root.create('a-file/inner', DETAILS, writeB), { code: 'ENOTDIR' });

      assert.strictEqual(await fs.promises.readFile(path.join(root.path, 'a-file'), 'utf8'), 'not an object');
      assert.ok(!fs.existsSync(workspaceOf(root)));
    });
  });

  describe('when a draft operation fails', () => {
    const cases: [string, (root: StorageRoot) => Promise<Run>, version: string][] = [
      ['create', async (root) => creating(root), 'v1'],
      ['update', async (root) => updating(await createObject(root, ID, { 'kept.txt': 'kept' })), 'v2'],
    ];

    for (const [how, start, version] of cases) {
      it(`throws the original error, unwrapped, from ${how} when the failure could not be undone`, async () => {
        const root = await newRoot();
        const run = await start(root);
        const before = await snapshot(objectRootOf(root, ID));
        let rejection: unknown;

        const outcome = run(async (draft) => {
          await draft.write('a', 'AAA');
          await draft.write('b', 'AAA');
          // Putting the new content in place fails, and so does moving the shared content back
          await withFsFailure(
            'rename',
            (_, target) => target === path.join(workspaceOf(root), ID, version, 'content', 'a'),
            () =>
              draft.write('a', 'ZZZ').catch((error) => {
                rejection = error;
              }),
          );
        });

        await assert.rejects(outcome, (e) => e === rejection);
        assert.match((rejection as Error).message, /injected failure/);
        assert.deepStrictEqual(await snapshot(objectRootOf(root, ID)), before);
        assertNoExtensions(root);
      });

      for (const [name, content] of failingPartway) {
        it(`fails the write of ${name} in ${how === 'create' ? 'a' : 'an'} ${how} and leaves nothing of it behind`, async () => {
          const root = await newRoot();
          const run = await start(root);

          const committed = await run(async (draft) => {
            await assert.rejects(draft.write('broken', content()), /source failed/);
            await draft.write('ok', 'ok');
          });

          const objectRoot = objectRootOf(root, ID);
          assert.strictEqual((await textFiles(committed.head)).broken, undefined);
          assert.deepStrictEqual(await storedFiles(objectRoot, version), [`${version}/content/ok`]);
          await assertVersionValid(objectRoot, version);
          assertNoExtensions(root);
        });
      }
    }

    it('discards the draft when the callback lets a failed stream through', async () => {
      const root = await newRoot();
      await assert.rejects(
        root.create(ID, DETAILS, async (draft) => {
          await draft.write('ok', 'ok');
          await draft.write('broken', failingPartway[0]![1]());
        }),
        /source failed/,
      );
      await assertNoPartialObject(root);
    });
  });

  describe('when a step of the commit fails', () => {
    for (const { step, method, target } of commitSteps) {
      it(`leaves an existing object intact when ${step} fails`, async () => {
        const existing = await existingObject();
        const { root, object, objectRoot } = existing;
        const failing = target(objectRoot, path.join(workspaceOf(root), ID), 'v2');

        await withFsFailure(method, failing, () => assert.rejects(object.update(DETAILS, writeB), /injected failure/));

        await assertStillAtV1(existing);
        const updated = await object.update(DETAILS, writeB);
        assert.strictEqual(updated.head.number, 2);
        assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'b.txt': 'b' });
      });

      it(`leaves no partial object when ${step} fails on a new object`, async () => {
        const root = await newRoot();
        const failing = target(objectRootOf(root, ID), path.join(workspaceOf(root), ID), 'v1');

        await withFsFailure(method, failing, () => assert.rejects(root.create(ID, DETAILS, writeB), /injected failure/));

        await assertNoPartialObject(root);
      });
    }

    it('keeps a file that only looks like its staged inventory when nothing was staged', async () => {
      const existing = await existingObject();
      const lookalike = path.join(existing.objectRoot, 'inventory.json.tmp');
      await fs.promises.writeFile(lookalike, 'not ours');

      await throwing(updating(existing.object));
      await existing.object.update(DETAILS, async () => {});

      assert.strictEqual(await fs.promises.readFile(lookalike, 'utf8'), 'not ours');
    });
  });

  describe('with the workspace on another file system from the object', () => {
    it('fails a create with CROSS_FILESYSTEM_MOVE and leaves nothing behind', async () => {
      const root = await newRoot();
      mountSeparately(path.join(root.path, 'extensions'));

      await assert.rejects(root.create(ID, DETAILS, writeB), ocflError('CROSS_FILESYSTEM_MOVE'));

      mock.restoreAll();
      await assertNoPartialObject(root);
    });

    it('fails an update with CROSS_FILESYSTEM_MOVE and leaves the object at its previous version', async () => {
      const existing = await existingObject();
      mountSeparately(path.join(existing.root.path, 'extensions'));

      await assert.rejects(existing.object.update(DETAILS, writeB), ocflError('CROSS_FILESYSTEM_MOVE'));

      mock.restoreAll();
      await assertStillAtV1(existing);
    });
  });

  describe('tidying the workspace', () => {
    const outcomes: [string, (run: Run) => Promise<unknown>][] = [
      ['a failed', throwing],
      ['a successful', (run) => run(writeB)],
    ];

    for (const [name, update] of outcomes) {
      it(`keeps unrelated workspace content after ${name} update`, async () => {
        const root = await newRoot();
        const workspace = workspaceOf(root);
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.writeFile(path.join(workspace, 'unrelated.txt'), 'keep');

        await update(creating(root));

        assert.deepStrictEqual(await snapshot(workspace), { 'unrelated.txt': 'keep' });
        assert.deepStrictEqual(await emptyDirectoriesUnder(workspace), []);
      });

      it(`removes the workspace and extensions directories left empty by ${name} update`, async () => {
        const root = await newRoot();
        await update(creating(root));
        assertNoExtensions(root);

        const object = await root.open(ID).catch(() => createObject(root, ID, {}));
        await update(updating(object));
        assertNoExtensions(root);
      });

      for (const layout of [FLAT, { extensionName: HASHED }] as const) {
        it(`assembles the version in the workspace and leaves no empty directories after ${name} update (${layout.extensionName})`, async () => {
          const root = await newRoot(layout);
          const workspace = workspaceOf(root);
          let assembling: string[] = [];

          await update((change) =>
            root.create(ID, DETAILS, async (draft) => {
              await draft.write('dir/a.txt', 'a');
              assembling = Object.keys(await snapshot(workspace));
              await change(draft);
            }),
          );

          assert.strictEqual(assembling.length, 1);
          assert.ok(assembling[0]!.endsWith(path.join('v1', 'content', 'dir', 'a.txt')), assembling[0]);
          assert.ok(!fs.existsSync(workspace));
          assert.deepStrictEqual(await emptyDirectoriesUnder(root.path), []);
        });
      }
    }

    it('does not disturb another update in progress in the same storage root', async () => {
      const root = await newRoot();
      const a = await createObject(root, 'a', { 'a.txt': 'a' });
      const reserved = path.join(workspaceOf(root), 'a', 'v2');

      const updated = await a.update(DETAILS, async (draft) => {
        await draft.write('new.txt', 'new');
        await createObject(root, 'b', { 'b.txt': 'b' });
        assert.ok(fs.existsSync(reserved));
        await throwing((change) => root.create('c', DETAILS, change));
        assert.ok(fs.existsSync(reserved));
      });

      assert.strictEqual(updated.head.number, 2);
      assert.deepStrictEqual(await textFiles(updated.head), { 'a.txt': 'a', 'new.txt': 'new' });
      assert.deepStrictEqual(await textFiles((await root.open('b')).head), { 'b.txt': 'b' });
      assertNoExtensions(root);
    });

    it("reports the callback's error when the empty workspace cannot be removed", async () => {
      const root = await newRoot();
      await withFsFailure('rmdir', path.join(workspaceOf(root), ID), () => throwing(creating(root)));
      assert.ok(!fs.existsSync(objectRootOf(root, ID)));
    });

    it("reports the callback's error when what the draft wrote cannot be removed", async () => {
      const root = await newRoot();
      await withFsFailure('rm', path.join(workspaceOf(root), ID, 'v1'), () => throwing(creating(root)), 'EACCES');
    });

    it('resolves when the committed update cannot remove its empty workspace', async () => {
      const root = await newRoot();

      const created = await withFsFailure('rmdir', path.join(workspaceOf(root), ID), () => root.create(ID, DETAILS, writeB));

      assert.strictEqual(created.head.number, 1);
      assert.deepStrictEqual(await textFiles((await root.open(ID)).head), { 'b.txt': 'b' });
    });
  });

  describe('using the draft after the update has finished', () => {
    it('throws an Error once a create has committed, writing nothing', async () => {
      const root = await newRoot();
      let leaked: Draft | undefined;
      await root.create(ID, DETAILS, async (draft) => {
        leaked = draft;
        await writeB(draft);
      });
      const before = await snapshot(root.path);

      await assert.rejects(leaked!.write('late.txt', 'late'), isFinishedDraft);

      assert.deepStrictEqual(await snapshot(root.path), before);
    });

    it('throws an Error once an update has committed, writing nothing', async () => {
      const existing = await existingObject();
      let leaked: Draft | undefined;
      await existing.object.update(DETAILS, async (draft) => {
        leaked = draft;
        await writeB(draft);
      });
      const before = await snapshot(existing.root.path);

      await assert.rejects(leaked!.write('late.txt', 'late'), isFinishedDraft);

      assert.deepStrictEqual(await snapshot(existing.root.path), before);
    });

    it('throws an Error once the update has been discarded', async () => {
      const root = await newRoot();
      let leaked: Draft | undefined;
      await throwing((change) =>
        root.create(ID, DETAILS, async (draft) => {
          leaked = draft;
          await change(draft);
        }),
      );

      await assert.rejects(leaked!.write('late.txt', 'late'), isFinishedDraft);

      await assertNoPartialObject(root);
    });
  });
});
