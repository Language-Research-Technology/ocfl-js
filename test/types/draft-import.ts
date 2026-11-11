import type { Draft } from '../../src/index.ts';

export async function importTakesOneSourceAndAnOptionalTarget(draft: Draft): Promise<void> {
  await draft.import('/data/dir');
  await draft.import('/data/dir', 'dir');
  await draft.import('/data/a.txt', undefined);

  // @ts-expect-error the source is required
  await draft.import();
  // @ts-expect-error one source per call: call import once for each
  await draft.import(['/data/a', '/data/b']);
  // @ts-expect-error one source per call: call import once for each
  await draft.import([{ source: '/data/a', target: 'a' }]);
  // @ts-expect-error a source is a path
  await draft.import({ source: '/data/a', target: 'a' });
  // @ts-expect-error a source is a path on disk, not content: use write
  await draft.import(new Uint8Array(1), 'a');
  // @ts-expect-error there are no update modes
  await draft.import('/data/dir', { mode: 'REPLACE' });
  // @ts-expect-error the message and user belong to the update
  await draft.import('/data/dir', 'dir', { message: 'Nightly sync', user: { name: 'importer' } });

  const settled: Promise<void> = draft.import('/data/dir');
  // @ts-expect-error nothing is returned: a failed import throws
  const errors: unknown[] = await draft.import('/data/dir');
  return settled.then(() => void errors);
}
