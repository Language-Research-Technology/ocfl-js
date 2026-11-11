import type { Draft } from '../../src/index.ts';

export async function renameTakesASourceAndATarget(draft: Draft): Promise<number> {
  await draft.rename('a', 'b');
  await draft.rename('dir', 'other/dir');

  // @ts-expect-error the source and target are required
  await draft.rename();
  // @ts-expect-error the target is required
  await draft.rename('a');
  // @ts-expect-error one source per call: call rename once for each
  await draft.rename(['a', 'b'], 'dir');
  // @ts-expect-error a source and a target, not a pair
  await draft.rename({ source: 'a', target: 'b' });
  // @ts-expect-error the source is a path in the draft, not a file of a version
  await draft.rename({ path: 'a', version: 1 }, 'b');

  const settled: Promise<void> = draft.rename('a', 'b');
  await settled;
  // @ts-expect-error resolves to nothing, not a count
  return draft.rename('a', 'b');
}
