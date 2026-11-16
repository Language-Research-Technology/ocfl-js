import type fs from 'node:fs';
import type { Draft, ImportOptions } from '../../src/index.ts';

export async function importTakesOneSourceAndOptionalOptions(draft: Draft): Promise<void> {
  await draft.import('/data/dir');
  await draft.import('/data/dir', { target: 'dir' });
  await draft.import('/data/a.txt', undefined);
  await draft.import('/data/a.txt', {});
  await draft.import('/data/dir', { target: undefined });

  // @ts-expect-error the source is required
  await draft.import();
  // @ts-expect-error the target goes in the options: { target: 'dir' }
  await draft.import('/data/dir', 'dir');
  // @ts-expect-error one source per call: call import once for each
  await draft.import(['/data/a', '/data/b']);
  // @ts-expect-error one source per call: call import once for each
  await draft.import([{ source: '/data/a', target: 'a' }]);
  // @ts-expect-error a source is a path
  await draft.import({ source: '/data/a', target: 'a' });
  // @ts-expect-error a source is a path on disk, not content: use write
  await draft.import(new Uint8Array(1), { target: 'a' });
  // @ts-expect-error there are no update modes
  await draft.import('/data/dir', { mode: 'REPLACE' });
  // @ts-expect-error the message and user belong to the update
  await draft.import('/data/dir', { target: 'dir', message: 'Nightly sync', user: { name: 'importer' } });

  const settled: Promise<void> = draft.import('/data/dir');
  // @ts-expect-error nothing is returned: a failed import throws
  const errors: unknown[] = await draft.import('/data/dir');
  return settled.then(() => void errors);
}

export async function theFilterSeesEachEntryAndKeepsItWithTrue(draft: Draft): Promise<void> {
  await draft.import('/data/crate', {
    filter: (relativePath, entry) => {
      const name: string = entry.name;
      const dirent: fs.Dirent = entry;
      return !relativePath.startsWith('.git/') && name !== '.DS_Store' && !dirent.isSymbolicLink();
    },
  });
  await draft.import('/data/crate', { target: 'raw', filter: (relativePath) => relativePath !== 'skip.txt' });

  // @ts-expect-error the filter returns whether to keep the entry
  await draft.import('/data/crate', { filter: () => 'yes' });
  // @ts-expect-error the filter is synchronous
  await draft.import('/data/crate', { filter: async () => true });
  // @ts-expect-error the filter is a function
  await draft.import('/data/crate', { filter: '.git' });

  const options: ImportOptions = { target: 'raw' };
  // @ts-expect-error options can't be changed once made
  options.target = 'other';
}
