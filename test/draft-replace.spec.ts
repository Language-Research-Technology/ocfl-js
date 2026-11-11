import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Draft, StorageRoot } from '../src/index.ts';
import { assertHolds, createObject, DETAILS, encode, objectRootOf, readInventory, sha512, streamOf, useTempRoots, workspaceOf } from './helpers/drafts.ts';
import { withFsFailure } from './helpers/fs-failures.ts';

describe('replacing a file within one draft', () => {
  const temp = useTempRoots('ocfl-draft-replace-');
  let root: StorageRoot;
  let count = 0;
  const newId = () => `object-${count++}`;

  before(async () => {
    root = await temp.newRoot();
  });

  type Write = (draft: Draft, logicalPath: string, content: string) => Promise<void>;
  const writes: [string, Write][] = [
    ['a string', (d, p, c) => d.write(p, c)],
    ['a buffer', (d, p, c) => d.write(p, encode(c))],
    ['a stream', (d, p, c) => d.write(p, streamOf(c))],
    [
      'import',
      async (d, p, c) => {
        const source = path.join(temp.dir, `source-${count++}`);
        await fs.promises.writeFile(source, c);
        await d.import(source, p);
      },
    ],
  ];

  const scenarios = [
    'a=AAA, a=BBB',
    'a=AAA, a=BBB, a=AAA',
    'a=AAA, a=BBB, c=AAA',
    'a=AAA, b=AAA, a=BBB',
    'a=AAA, a=AAA',
    'a=AAA, b=AAA, a=AAA',
    'a=AAA, b=BBB, a=BBB',
    'a=AAA, b=AAA, c=BBB, a=BBB',
    'a=AAA, c=AAA, b=BBB, a=BBB, c=CCC',
    'x/y/a=AAA, b=BBB, x/y/a=BBB',
    'x/a=AAA, b=AAA, c=BBB, x/a=BBB',
    'x/a=AAA, y/z/b=AAA, x/a=BBB',
  ];

  for (const [kind, write] of writes) {
    describe(`with ${kind}`, () => {
      for (const name of scenarios) {
        const steps = name.split(', ').map((step) => step.split('=') as [string, string]);
        it(`${name} commits and reads back`, async () => {
          const object = await root.create(newId(), DETAILS, async (draft) => {
            for (const [logicalPath, content] of steps) {
              await write(draft, logicalPath, content);
            }
          });
          await assertHolds(root, object, Object.fromEntries(steps));
        });
      }
    });
  }

  it('leaves only the new content in the manifest', async () => {
    const object = await root.create(newId(), DETAILS, async (draft) => {
      await draft.write('a', 'AAA');
      await draft.write('a', 'BBB');
    });
    const inventory = await assertHolds(root, object, { a: 'BBB' });
    assert.deepStrictEqual(inventory.manifest, { [sha512('BBB')]: ['v1/content/a'] });
  });

  for (const [how, share] of [
    ['write', (draft: Draft) => draft.write('b', 'AAA')],
    ['copy', (draft: Draft) => draft.copy('a', 'b')],
  ] as const) {
    it(`stores shared content at the path of a logical path made with ${how}, with the manifest`, async () => {
      const object = await root.create(newId(), DETAILS, async (draft) => {
        await draft.write('a', 'AAA');
        await share(draft);
        await draft.write('a', 'BBB');
      });
      const inventory = await assertHolds(root, object, { a: 'BBB', b: 'AAA' });
      assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/b'], [sha512('BBB')]: ['v1/content/a'] });
    });
  }

  it('leaves earlier versions unchanged when the same replacements happen in a second version', async () => {
    const object = await createObject(root, newId(), { a: 'AAA', b: 'AAA' });
    const objectRoot = objectRootOf(root, object.id);
    const v1 = await readInventory(objectRoot);
    const v1File = await fs.promises.readFile(path.join(objectRoot, 'v1/content/a'));
    const updated = await object.update(DETAILS, async (draft) => {
      await draft.write('a', 'BBB');
      await draft.write('c', 'BBB');
      await draft.write('a', 'CCC');
      await draft.write('b', 'DDD');
      await draft.write('b', 'AAA');
    });
    const inventory = await assertHolds(root, updated, { a: 'CCC', b: 'AAA', c: 'BBB' });
    assert.deepStrictEqual(inventory.manifest[sha512('AAA')], v1.manifest[sha512('AAA')]);
    assert.deepStrictEqual(inventory.versions.v1, v1.versions.v1);
    assert.deepStrictEqual(await fs.promises.readFile(path.join(objectRoot, 'v1/content/a')), v1File);
  });

  it('leaves no content directory when replacements in a second version store nothing new', async () => {
    const object = await createObject(root, newId(), { a: 'AAA', b: 'BBB' });
    const updated = await object.update(DETAILS, async (draft) => {
      await draft.write('a', 'CCC');
      await draft.write('a', 'BBB');
    });
    await assertHolds(root, updated, { a: 'BBB', b: 'BBB' });
    assert.ok(!fs.existsSync(path.join(objectRootOf(root, object.id), 'v2/content')));
  });

  it('keeps shared content where it was if the new content cannot be put in place', async () => {
    const id = newId();
    const own = path.join(workspaceOf(root), id, 'v1/content/a');
    const object = await root.create(id, DETAILS, async (draft) => {
      await draft.write('a', 'AAA');
      await draft.write('b', 'AAA');
      await withFsFailure(
        'rename',
        (source, target) => target === own && source.includes('.staged-'),
        () => assert.rejects(draft.write('a', 'BBB'), /injected failure/),
      );
    });
    const inventory = await assertHolds(root, object, { a: 'AAA', b: 'AAA' });
    assert.deepStrictEqual(inventory.manifest, { [sha512('AAA')]: ['v1/content/a'] });
  });

  it('leaves no directory behind from moving shared content when the new content cannot be put in place', async () => {
    const id = newId();
    const own = path.join(workspaceOf(root), id, 'v1/content/x/a');
    const object = await root.create(id, DETAILS, async (draft) => {
      await draft.write('x/a', 'AAA');
      await draft.write('y/z/b', 'AAA');
      await withFsFailure(
        'rename',
        (source, target) => target === own && source.includes('.staged-'),
        () => assert.rejects(draft.write('x/a', 'BBB'), /injected failure/),
      );
    });
    await assertHolds(root, object, { 'x/a': 'AAA', 'y/z/b': 'AAA' });
  });

  describe('started together', () => {
    const ROUNDS = 20;

    for (let round = 0; round < ROUNDS; round++) {
      describe(`round ${round}`, () => {
        it('concurrent writes of identical streams to one logical path leave it readable', async () => {
          const object = await root.create(newId(), DETAILS, async (draft) => {
            await Promise.all([draft.write('a', streamOf('same')), draft.write('a', streamOf('same'))]);
          });
          await assertHolds(root, object, { a: 'same' });
        });

        it('concurrent writes of different content to one logical path end with the last one called', async () => {
          const object = await root.create(newId(), DETAILS, async (draft) => {
            await Promise.all([draft.write('a', 'A'.repeat(1_000_000)), draft.write('a', 'BBB')]);
          });
          const inventory = await assertHolds(root, object, { a: 'BBB' });
          assert.deepStrictEqual(inventory.manifest, { [sha512('BBB')]: ['v1/content/a'] });
        });
      });
    }
  });
});
