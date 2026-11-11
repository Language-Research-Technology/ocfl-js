import type { Draft } from '../../src/index.ts';

export async function copyTakesASourceAndATarget(draft: Draft): Promise<number> {
  await draft.copy('a', 'b');
  await draft.copy('dir', 'other/dir');

  // @ts-expect-error the source and target are required
  await draft.copy();
  // @ts-expect-error the target is required
  await draft.copy('a');
  // @ts-expect-error one source per call: call copy once for each
  await draft.copy(['a', 'b'], 'dir');
  // @ts-expect-error a source and a target, not a pair
  await draft.copy({ source: 'a', target: 'b' });
  // @ts-expect-error the source is a path in the draft, not a file of a version
  await draft.copy({ path: 'a', version: 1 }, 'b');

  const settled: Promise<void> = draft.copy('a', 'b');
  await settled;
  // @ts-expect-error resolves to nothing, not a count
  return draft.copy('a', 'b');
}
