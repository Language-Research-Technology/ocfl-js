import type { Draft } from '../../src/index.ts';

export async function removeTakesOnlyAPath(draft: Draft): Promise<number> {
  // @ts-expect-error the path is required: clear() removes everything
  await draft.remove();
  // @ts-expect-error one path at a time
  await draft.remove(['a', 'b']);
  // @ts-expect-error there are no options: a file can't be purged from earlier versions
  await draft.remove('a', { purge: true });
  // @ts-expect-error the old name
  await draft.delete('a');
  await draft.remove('a');
  // @ts-expect-error resolves to nothing, not a count
  return draft.remove('a');
}

export async function clearTakesNothing(draft: Draft): Promise<number> {
  // @ts-expect-error clear removes everything: use remove() for one path
  await draft.clear('a');
  await draft.clear();
  // @ts-expect-error resolves to nothing, not a count
  return draft.clear();
}
