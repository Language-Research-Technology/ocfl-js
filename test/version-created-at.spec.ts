import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { VersionDetails } from '../src/index.ts';
import { assertWritesNothing, DETAILS, objectRootOf, readInventory, useTempRoots, writeB, writeC } from './helpers/drafts.ts';
import { ocflError } from './helpers/ocfl-error.ts';

describe('dating a version', () => {
  const temp = useTempRoots('ocfl-created-at-');
  const MARCH_2019 = new Date('2019-03-01T00:00:00Z');

  it('dates a created version at the createdAt given, as an ISO 8601 UTC timestamp', async () => {
    const root = await temp.newRoot();
    const object = await root.create('dated', { ...DETAILS, createdAt: MARCH_2019 }, writeB);
    assert.strictEqual(object.head.createdAt.getTime(), MARCH_2019.getTime());
    assert.strictEqual((await root.open('dated')).head.createdAt.getTime(), MARCH_2019.getTime());
    assert.strictEqual((await readInventory(objectRootOf(root, 'dated'))).versions.v1?.created, '2019-03-01T00:00:00.000Z');
  });

  it('dates a version now when no createdAt is given', async () => {
    const root = await temp.newRoot();
    const before = Date.now();
    const object = await root.create('undated', DETAILS, writeB);
    assert.ok(object.head.createdAt.getTime() >= before && object.head.createdAt.getTime() <= Date.now());
  });

  it('allows an update dated the same as the head, or in the future', async () => {
    const root = await temp.newRoot();
    const v1 = await root.create('same', { ...DETAILS, createdAt: MARCH_2019 }, writeB);
    const v2 = await v1.update({ ...DETAILS, createdAt: new Date(MARCH_2019) }, writeC);
    assert.strictEqual(v2.head.createdAt.getTime(), MARCH_2019.getTime());
    const future = new Date(Date.now() + 86_400_000);
    const v3 = await v2.update({ ...DETAILS, createdAt: future }, (draft) => draft.write('d.txt', 'd'));
    assert.strictEqual(v3.head.createdAt.getTime(), future.getTime());
  });

  it('refuses an update dated earlier than the head, and changes nothing', async () => {
    const root = await temp.newRoot();
    const object = await root.create('earlier', { ...DETAILS, createdAt: MARCH_2019 }, writeB);
    await assertWritesNothing(root, object, () =>
      assert.rejects(object.update({ ...DETAILS, createdAt: new Date('2019-02-28T23:59:59Z') }, writeC), TypeError),
    );
  });

  for (const [what, createdAt] of [
    ['an invalid Date', new Date('not a date')],
    ['a string', '2019-03-01T00:00:00Z'],
    ['a number', 1551398400000],
  ] as const) {
    it(`refuses ${what} as createdAt, creating nothing`, async () => {
      const root = await temp.newRoot();
      await assert.rejects(root.create('invalid', { ...DETAILS, createdAt } as unknown as VersionDetails, writeB), TypeError);
      await assert.rejects(root.open('invalid'), ocflError('OBJECT_NOT_FOUND'));
    });
  }

  it("keeps the date given, though the caller's Date changes during the update", async () => {
    const root = await temp.newRoot();
    const createdAt = new Date(MARCH_2019);
    const object = await root.create('kept', { ...DETAILS, createdAt }, async (draft) => {
      createdAt.setFullYear(2030);
      await writeB(draft);
    });
    assert.strictEqual(object.head.createdAt.getTime(), MARCH_2019.getTime());
  });
});
