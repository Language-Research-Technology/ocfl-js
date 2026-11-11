import type { Draft, OcflObject } from '../../src/index.ts';

export async function reinstateTakesAPathAndAVersionNumber(draft: Draft, object: OcflObject): Promise<number> {
  await draft.reinstate('a', 1);
  await draft.reinstate('dir', object.head.number);
  for (const number of object.versions.keys()) {
    await draft.reinstate('a', number);
  }

  // @ts-expect-error the path and version are required
  await draft.reinstate();
  // @ts-expect-error the version is required
  await draft.reinstate('a');
  // @ts-expect-error a version is a number, not a name
  await draft.reinstate('a', 'v1');
  // @ts-expect-error a version is a number, not a Version
  await draft.reinstate('a', object.head);
  // @ts-expect-error there is no target: reinstate then rename
  await draft.reinstate('a', 1, 'b');
  // @ts-expect-error there are no options: a directory always merges
  await draft.reinstate('dir', 1, { merge: true });
  // @ts-expect-error one path per call: call reinstate once for each
  await draft.reinstate(['a', 'b'], 1);
  // @ts-expect-error a path and a version, not a pair
  await draft.reinstate({ path: 'a', version: 1 });

  const settled: Promise<void> = draft.reinstate('a', 1);
  await settled;
  // @ts-expect-error resolves to nothing, not a count
  return draft.reinstate('a', 1);
}
