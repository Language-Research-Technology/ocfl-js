import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Draft, StorageRoot } from '../src/index.ts';
import { withFsFailure } from './fs-failures.ts';
import {
  assertHolds,
  assertWritesNothing,
  createObject,
  DETAILS,
  objectRootOf,
  readInventory,
  sha512,
  snapshot,
  storedFiles,
  textFiles,
  useTempRoots,
  workspaceOf,
} from './helpers/drafts.ts';
import { ocflError } from './ocfl-error.ts';

describe('merging a directory into another in a draft', () => {
  const temp = useTempRoots('ocfl-draft-merge-');
  let root: StorageRoot;
  let objectCount = 0;
  const newId = () => `object-${objectCount++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  const MERGE = { merge: true };
  type Transfer = (draft: Draft, source: string, target: string, options?: { merge: boolean }) => Promise<void>;
  const operations: [name: 'copy' | 'rename', transfer: Transfer][] = [
    ['copy', (draft, source, target, options) => draft.copy(source, target, options)],
    ['rename', (draft, source, target, options) => draft.rename(source, target, options)],
  ];

  /** Asserts that `operation` is refused with `code` in an update of an object holding `files`, and that the update writes nothing */
  async function assertRefused(files: Record<string, string>, operation: (draft: Draft) => Promise<void>, code: 'FILE_EXISTS' | 'INVALID_LOGICAL_PATH') {
    const object = await createObject(root, newId(), files);
    await assertWritesNothing(root, object, async () => {
      const returned = await object.update(DETAILS, async (draft) => {
        await assert.rejects(operation(draft), ocflError(code));
      });
      assert.strictEqual(returned, object);
    });
    await assertHolds(root, object, files);
  }

  /** `files` without those at or below `directory`, if it is given */
  const without = (files: Record<string, string>, directory?: string) =>
    Object.fromEntries(Object.entries(files).filter(([logicalPath]) => directory === undefined || !logicalPath.startsWith(`${directory}/`)));

  for (const [op, transfer] of operations) {
    const sourceGone = op === 'rename' ? 'src' : undefined;

    describe(`${op} with { merge: true }`, () => {
      it("adds the source's files and keeps the target's when no file clashes", async () => {
        const files = { 'src/a': 'A', 'src/deep/b': 'B', 'dst/c': 'C', 'dst/deep/d': 'D', keep: 'K' };
        const object = await createObject(root, newId(), files);
        const objectRoot = objectRootOf(root, object.id);
        const v1 = await readInventory(objectRoot);
        const updated = await object.update(DETAILS, async (draft) => {
          assert.strictEqual(await transfer(draft, 'src', 'dst', MERGE), undefined);
        });
        const inventory = await assertHolds(root, updated, {
          ...without(files, sourceGone),
          'dst/a': 'A',
          'dst/deep/b': 'B',
        });
        assert.deepStrictEqual(inventory.manifest, v1.manifest);
        assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
        assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), files);
      });

      it('replaces files at the same path and keeps the rest', async () => {
        const files = { 'src/a': 'A', 'src/deep/b': 'B', 'src/only': 'S', 'dst/a': 'old a', 'dst/deep/b': 'old b', 'dst/deep/kept': 'T', 'dst/kept': 'U' };
        const object = await createObject(root, newId(), files);
        const objectRoot = objectRootOf(root, object.id);
        const v1 = await readInventory(objectRoot);
        const updated = await object.update(DETAILS, async (draft) => {
          await transfer(draft, 'src', 'dst', MERGE);
        });
        const inventory = await assertHolds(root, updated, {
          ...without(files, sourceGone),
          'dst/a': 'A',
          'dst/deep/b': 'B',
          'dst/only': 'S',
        });
        assert.deepStrictEqual(inventory.manifest, v1.manifest);
        assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
        assert.deepStrictEqual(await textFiles(updated.versions.get(1)!), files);
      });

      it('leaves a target file that already holds the same content as it is', async () => {
        const files = { 'src/a': 'A', 'src/b': 'B', 'dst/a': 'A', 'dst/b': 'old b' };
        const object = await createObject(root, newId(), files);
        const updated = await object.update(DETAILS, async (draft) => {
          await transfer(draft, 'src', 'dst', MERGE);
        });
        const inventory = await assertHolds(root, updated, { ...without(files, sourceGone), 'dst/b': 'B' });
        assert.deepStrictEqual(
          inventory.versions.v2!.state[sha512('A')]?.filter((file) => file.startsWith('dst/')),
          ['dst/a'],
        );
      });

      it('accepts an un-normalised source and target', async () => {
        const files = { 'src/a': 'A', 'dst/a': 'old a', 'dst/b': 'B' };
        const object = await createObject(root, newId(), files);
        const updated = await object.update(DETAILS, async (draft) => {
          await transfer(draft, './src/', 'dst//', MERGE);
        });
        await assertHolds(root, updated, { ...without(files, sourceGone), 'dst/a': 'A' });
      });

      it('merges a directory into the directory it is in, onto its own files', async () => {
        const files = { 'd/sub/y': 'Y1', 'd/sub/sub/y': 'Y2', 'd/y': 'Y0', 'd/keep': 'K' };
        const object = await createObject(root, newId(), files);
        const objectRoot = objectRootOf(root, object.id);
        const v1 = await readInventory(objectRoot);
        const updated = await object.update(DETAILS, async (draft) => {
          await transfer(draft, 'd/sub', 'd', MERGE);
        });
        const moved = { 'd/y': 'Y1', 'd/sub/y': 'Y2', 'd/keep': 'K' };
        const inventory = await assertHolds(root, updated, op === 'rename' ? moved : { ...moved, 'd/sub/sub/y': 'Y2' });
        assert.deepStrictEqual(inventory.manifest, v1.manifest);
        assert.deepStrictEqual(await storedFiles(objectRoot, 'v2'), []);
      });

      for (const [name, files] of [
        ['a file where the target has a directory', { 'src/a': 'A', 'src/b': 'B', 'dst/a/x': 'X' }],
        ['a directory where the target has a file', { 'src/a/x': 'X', 'src/b': 'B', 'dst/a': 'A' }],
        ['a file below a file of the target', { 'src/a/x/y': 'Y', 'src/b': 'B', 'dst/a': 'A', 'dst/b': 'old b' }],
      ] as const) {
        it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
          await assertRefused(files, (draft) => transfer(draft, 'src', 'dst', MERGE), 'FILE_EXISTS');
        });
      }

      for (const [name, source, target] of [
        ['a directory onto a file', 'src', 'file'],
        ['a directory below a file', 'src', 'file/sub'],
        ['a file onto a directory', 'file', 'dst'],
        ['a file onto the directory it is in', 'dst/c', 'dst'],
        ['a directory onto the directory it is in, where a file would be a directory', 'dst/deep', 'dst'],
      ] as const) {
        it(`throws FILE_EXISTS for ${name}, changing nothing`, async () => {
          const files = { 'src/a': 'A', 'dst/c': 'C', 'dst/deep/deep': 'D', 'dst/deep/e': 'E', file: 'F' };
          await assertRefused(files, (draft) => transfer(draft, source, target, MERGE), 'FILE_EXISTS');
        });
      }

      it('throws FILE_EXISTS for a clash without dropping content the draft stored', async () => {
        const id = newId();
        const object = await root.create(id, DETAILS, async (draft) => {
          await draft.write('src/a', 'A');
          await draft.write('src/b/x', 'X');
          await draft.write('dst/a', 'old a');
          await draft.write('dst/b', 'old b');
          const stored = await snapshot(path.join(workspaceOf(root), id));
          await assert.rejects(transfer(draft, 'src', 'dst', MERGE), ocflError('FILE_EXISTS'));
          assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
        });
        await assertHolds(root, object, { 'src/a': 'A', 'src/b/x': 'X', 'dst/a': 'old a', 'dst/b': 'old b' });
      });

      it('throws INVALID_LOGICAL_PATH for a directory into itself, changing nothing', async () => {
        await assertRefused({ 'd/x': 'X', 'd/sub/y': 'Y' }, (draft) => transfer(draft, 'd', 'd/sub', MERGE), 'INVALID_LOGICAL_PATH');
      });

      it('does nothing for the same source and target, and a draft holding only that writes no version', async () => {
        const object = await createObject(root, newId(), { 'd/x': 'X' });
        await assertWritesNothing(root, object, async () => {
          const returned = await object.update(DETAILS, async (draft) => {
            await transfer(draft, 'd', './d/', MERGE);
          });
          assert.strictEqual(returned, object);
        });
      });

      it('behaves on a single file exactly as without it', async () => {
        const files = { a: 'A', b: 'B', 'd/x': 'X', 'e/y': 'Y' };
        const results = [];
        for (const options of [MERGE, undefined]) {
          const object = await createObject(root, newId(), files);
          const updated = await object.update(DETAILS, async (draft) => {
            await transfer(draft, 'a', 'b', options);
            await transfer(draft, 'd/x', 'new', options);
            await assert.rejects(transfer(draft, 'b', 'e', options), ocflError('FILE_EXISTS'));
            await assert.rejects(transfer(draft, 'b', 'new/x', options), ocflError('FILE_EXISTS'));
          });
          const expected = op === 'rename' ? { b: 'A', new: 'X', 'e/y': 'Y' } : { a: 'A', b: 'A', 'd/x': 'X', new: 'X', 'e/y': 'Y' };
          results.push(await assertHolds(root, updated, expected));
        }
        assert.deepStrictEqual(results[0]!.versions.v2!.state, results[1]!.versions.v2!.state);
        assert.deepStrictEqual(results[0]!.manifest, results[1]!.manifest);
      });

      it('behaves onto a target with no files exactly as without it', async () => {
        const files = { 'src/a': 'A', 'src/deep/b': 'B', keep: 'K' };
        const results = [];
        for (const options of [MERGE, undefined]) {
          const object = await createObject(root, newId(), files);
          const updated = await object.update(DETAILS, async (draft) => {
            await draft.write('src/new', 'NEW');
            await transfer(draft, 'src', 'dst/sub', options);
          });
          const inventory = await assertHolds(root, updated, {
            ...without(files, sourceGone),
            ...(op === 'copy' && { 'src/new': 'NEW' }),
            'dst/sub/a': 'A',
            'dst/sub/deep/b': 'B',
            'dst/sub/new': 'NEW',
          });
          results.push(inventory);
          assert.deepStrictEqual(inventory.manifest[sha512('NEW')], [op === 'rename' ? 'v2/content/dst/sub/new' : 'v2/content/src/new']);
        }
        assert.deepStrictEqual(results[0]!.versions.v2!.state, results[1]!.versions.v2!.state);
        assert.deepStrictEqual(results[0]!.manifest, results[1]!.manifest);
      });
    });

    describe(`${op} without { merge: true }`, () => {
      for (const [name, options] of [
        ['no options', undefined],
        ['{ merge: false }', { merge: false }],
      ] as const) {
        it(`throws FILE_EXISTS with ${name} for a directory onto a target with files, changing nothing`, async () => {
          const files = { 'src/a': 'A', 'dst/b': 'B', 'twin/a': 'A' };
          await assertRefused(files, (draft) => transfer(draft, 'src', 'dst', options), 'FILE_EXISTS');
          await assertRefused(files, (draft) => transfer(draft, 'src', 'twin', options), 'FILE_EXISTS');
        });
      }
    });

    describe(`${op} on a draft whose update has finished`, () => {
      it('throws an Error with { merge: true }, changing nothing', async () => {
        let kept: Draft | undefined;
        const object = await root.create(newId(), DETAILS, async (draft) => {
          kept = draft;
          await draft.write('src/a', 'A');
          await draft.write('dst/a', 'old a');
        });
        const before = await snapshot(root.path);
        await assert.rejects(transfer(kept!, 'src', 'dst', MERGE), (e) => e instanceof Error && !('code' in e));
        assert.deepStrictEqual(await snapshot(root.path), before);
        await assertHolds(root, object, { 'src/a': 'A', 'dst/a': 'old a' });
      });
    });
  }

  describe('when stored content cannot be moved or removed', () => {
    const moving = (from: string, to: string) => (source: string, target: string) => source.endsWith(from) && target.endsWith(to);
    const files = { 'src/a': 'A', 'src/b': 'B', 'dst/a': 'old a', 'dst/b': 'old b', 'dst/keep': 'K' };
    const merged = { 'dst/a': 'A', 'dst/b': 'B', 'dst/keep': 'K' };

    async function writeAll(draft: Draft) {
      for (const [logicalPath, content] of Object.entries(files)) {
        await draft.write(logicalPath, content);
      }
    }

    for (const [name, fails] of [
      ['a source file cannot be moved', moving('/content/src/b', '/content/dst/b')],
      ['a replaced file cannot be set aside', (source: string) => source.endsWith('/content/dst/b')],
    ] as const) {
      it(`puts files back and keeps the source when ${name} part-way through a merging rename`, async () => {
        const id = newId();
        const object = await root.create(id, DETAILS, async (draft) => {
          await writeAll(draft);
          const stored = await snapshot(path.join(workspaceOf(root), id));
          await withFsFailure('rename', fails, () => assert.rejects(draft.rename('src', 'dst', MERGE), /injected failure/));
          assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
        });
        const inventory = await assertHolds(root, object, files);
        assert.deepStrictEqual(
          Object.values(inventory.manifest).flat().sort(),
          Object.keys(files)
            .map((file) => `v1/content/${file}`)
            .sort(),
        );
      });
    }

    it('puts files back when a merging rename into the directory the source is in fails part-way', async () => {
      const id = newId();
      const chain = { 'd/sub/y': 'Y1', 'd/sub/sub/y': 'Y2', 'd/sub/sub/sub/y': 'Y3', 'd/y': 'Y0' };
      const object = await root.create(id, DETAILS, async (draft) => {
        for (const [logicalPath, content] of Object.entries(chain)) {
          await draft.write(logicalPath, content);
        }
        const stored = await snapshot(path.join(workspaceOf(root), id));
        await withFsFailure('rename', moving('/content/d/sub/sub/sub/y', '/content/d/sub/sub/y'), () =>
          assert.rejects(draft.rename('d/sub', 'd', MERGE), /injected failure/),
        );
        assert.deepStrictEqual(await snapshot(path.join(workspaceOf(root), id)), stored);
      });
      await assertHolds(root, object, chain);
    });

    it('can merge again after a failed merging rename', async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await writeAll(draft);
        await withFsFailure('rename', moving('/content/src/b', '/content/dst/b'), () => assert.rejects(draft.rename('src', 'dst', MERGE), /injected failure/));
        await draft.rename('src', 'dst', MERGE);
      });
      const inventory = await assertHolds(root, object, merged);
      assert.deepStrictEqual(Object.values(inventory.manifest).flat().sort(), ['v1/content/dst/a', 'v1/content/dst/b', 'v1/content/dst/keep']);
    });

    it('reports the original failure and does not commit when a merging rename cannot be undone', async () => {
      const id = newId();
      let failure: unknown;
      await assert.rejects(
        root.create(id, DETAILS, async (draft) => {
          await writeAll(draft);
          await withFsFailure(
            'rename',
            (source, target) => moving('/content/src/b', '/content/dst/b')(source, target) || target.endsWith('/content/dst/a'),
            async () => {
              failure = await draft.rename('src', 'dst', MERGE).catch((error: unknown) => error);
            },
          );
          assert.match(String(failure), /injected failure/);
        }),
        (error) => error === failure,
      );
      assert.ok(!fs.existsSync(objectRootOf(root, id)));
      assert.ok(!fs.existsSync(workspaceOf(root)));
    });

    for (const [name, transfer, doomed] of [
      ['rename', (draft: Draft) => draft.rename('src', 'dst', MERGE), (target: string) => path.basename(target).startsWith('.staged-')],
      ['copy', (draft: Draft) => draft.copy('src', 'dst', MERGE), (target: string) => target.endsWith('/content/dst/b')],
    ] as const) {
      it(`rejects a merging ${name} and the update when replaced content cannot be removed, leaving no partial object`, async () => {
        const id = newId();
        await assert.rejects(
          root.create(id, DETAILS, async (draft) => {
            await writeAll(draft);
            await withFsFailure('rm', doomed, () => assert.rejects(transfer(draft), /injected failure/));
          }),
          /injected failure/,
        );
        assert.ok(!fs.existsSync(objectRootOf(root, id)));
        assert.ok(!fs.existsSync(workspaceOf(root)));
      });
    }
  });

  describe('content the draft stored', () => {
    type Step = (draft: Draft) => Promise<void>;
    const write =
      (files: Record<string, string>): Step =>
      async (draft) => {
        for (const [logicalPath, content] of Object.entries(files)) {
          await draft.write(logicalPath, content);
        }
      };
    const copy: Step = (draft) => draft.copy('src', 'dst', MERGE);
    const rename: Step = (draft) => draft.rename('src', 'dst', MERGE);

    const scenarios: [name: string, steps: Step[], expected: Record<string, string>, manifest: Record<string, string>][] = [
      [
        'copy drops content stored only for a replaced file',
        [write({ 'src/a': 'A', 'dst/a': 'OLD', 'dst/keep': 'K' }), copy],
        { 'src/a': 'A', 'dst/a': 'A', 'dst/keep': 'K' },
        { A: 'src/a', K: 'dst/keep' },
      ],
      [
        'rename drops content stored only for a replaced file, and moves the source content to its place',
        [write({ 'src/a': 'A', 'dst/a': 'OLD', 'dst/keep': 'K' }), rename],
        { 'dst/a': 'A', 'dst/keep': 'K' },
        { A: 'dst/a', K: 'dst/keep' },
      ],
      [
        'copy replaces several files the draft wrote',
        [write({ 'src/a': 'A', 'src/b': 'B', 'dst/a': 'OLD A', 'dst/b': 'OLD B' }), copy],
        { 'src/a': 'A', 'src/b': 'B', 'dst/a': 'A', 'dst/b': 'B' },
        { A: 'src/a', B: 'src/b' },
      ],
      [
        'rename replaces several files the draft wrote',
        [write({ 'src/a': 'A', 'src/b': 'B', 'dst/a': 'OLD A', 'dst/b': 'OLD B' }), rename],
        { 'dst/a': 'A', 'dst/b': 'B' },
        { A: 'dst/a', B: 'dst/b' },
      ],
      [
        'copy moves content stored at a replaced file to a file outside the merge that still uses it',
        [write({ 'src/a': 'A', 'dst/a': 'OLD', other: 'OLD' }), copy],
        { 'src/a': 'A', 'dst/a': 'A', other: 'OLD' },
        { A: 'src/a', OLD: 'other' },
      ],
      [
        'rename moves content stored at a replaced file to a file outside the merge that still uses it',
        [write({ 'src/a': 'A', 'dst/a': 'OLD', other: 'OLD' }), rename],
        { 'dst/a': 'A', other: 'OLD' },
        { A: 'dst/a', OLD: 'other' },
      ],
      [
        'copy moves content stored at a replaced file to a source file that uses it',
        [write({ 'dst/a': 'X', 'src/a': 'A', 'src/b': 'X' }), copy],
        { 'src/a': 'A', 'src/b': 'X', 'dst/a': 'A', 'dst/b': 'X' },
        { A: 'src/a', X: 'src/b' },
      ],
      [
        'rename moves content stored at a replaced file to where a source file that uses it lands',
        [write({ 'dst/a': 'X', 'src/a': 'A', 'src/b': 'X' }), rename],
        { 'dst/a': 'A', 'dst/b': 'X' },
        { A: 'dst/a', X: 'dst/b' },
      ],
      [
        'rename, then write the old source name again',
        [write({ 'dst/a': 'X', 'src/a': 'A', 'src/b': 'X' }), rename, write({ 'src/b': 'NEW' })],
        { 'dst/a': 'A', 'dst/b': 'X', 'src/b': 'NEW' },
        { A: 'dst/a', X: 'dst/b', NEW: 'src/b' },
      ],
      [
        'copy two directories that hold the same content at swapped names',
        [write({ 'dst/a': 'ONE', 'dst/b': 'TWO', 'src/a': 'TWO', 'src/b': 'ONE' }), copy],
        { 'src/a': 'TWO', 'src/b': 'ONE', 'dst/a': 'TWO', 'dst/b': 'ONE' },
        { ONE: 'src/b', TWO: 'src/a' },
      ],
      [
        'rename two directories that hold the same content at swapped names',
        [write({ 'dst/a': 'ONE', 'dst/b': 'TWO', 'src/a': 'TWO', 'src/b': 'ONE' }), rename],
        { 'dst/a': 'TWO', 'dst/b': 'ONE' },
        { ONE: 'dst/b', TWO: 'dst/a' },
      ],
      [
        'rename a directory into the directory it is in, onto its own files',
        [write({ 'd/sub/y': 'Y1', 'd/sub/sub/y': 'Y2', 'd/sub/sub/sub/y': 'Y3', 'd/keep': 'K' }), (draft) => draft.rename('d/sub', 'd', MERGE)],
        { 'd/y': 'Y1', 'd/sub/y': 'Y2', 'd/sub/sub/y': 'Y3', 'd/keep': 'K' },
        { Y1: 'd/y', Y2: 'd/sub/y', Y3: 'd/sub/sub/y', K: 'd/keep' },
      ],
      [
        'rename a directory into the directory it is in, its files written deepest first',
        [write({ 'd/sub/sub/sub/y': 'Y3', 'd/sub/sub/y': 'Y2', 'd/sub/y': 'Y1', 'd/y': 'Y0' }), (draft) => draft.rename('d/sub', 'd', MERGE)],
        { 'd/y': 'Y1', 'd/sub/y': 'Y2', 'd/sub/sub/y': 'Y3' },
        { Y1: 'd/y', Y2: 'd/sub/y', Y3: 'd/sub/sub/y' },
      ],
      [
        'rename a directory into the directory it is in, onto its own files holding the same content',
        [write({ 'd/sub/y': 'Y', 'd/sub/sub/y': 'Y' }), (draft) => draft.rename('d/sub', 'd', MERGE)],
        { 'd/y': 'Y', 'd/sub/y': 'Y' },
        { Y: 'd/sub/y' },
      ],
      [
        'copy a directory into the directory it is in, onto its own files',
        [write({ 'd/sub/y': 'Y1', 'd/sub/sub/y': 'Y2', 'd/sub/sub/sub/y': 'Y3', 'd/keep': 'K' }), (draft) => draft.copy('d/sub', 'd', MERGE)],
        { 'd/y': 'Y1', 'd/sub/y': 'Y2', 'd/sub/sub/y': 'Y3', 'd/sub/sub/sub/y': 'Y3', 'd/keep': 'K' },
        { Y1: 'd/y', Y2: 'd/sub/y', Y3: 'd/sub/sub/sub/y', K: 'd/keep' },
      ],
    ];

    for (const [name, steps, expected, manifest] of scenarios) {
      it(`${name}: commits, stays valid and reads back`, async () => {
        const id = newId();
        const object = await root.create(id, DETAILS, async (draft) => {
          for (const step of steps) {
            await step(draft);
          }
          const stored = Object.keys(await snapshot(path.join(workspaceOf(root), id, 'v1'))).sort();
          assert.deepStrictEqual(
            stored,
            Object.values(manifest)
              .map((logicalPath) => `content/${logicalPath}`)
              .sort(),
          );
        });
        const inventory = await assertHolds(root, object, expected);
        assert.deepStrictEqual(
          inventory.manifest,
          Object.fromEntries(Object.entries(manifest).map(([content, logicalPath]) => [sha512(content), [`v1/content/${logicalPath}`]])),
        );
      });
    }
  });
});
