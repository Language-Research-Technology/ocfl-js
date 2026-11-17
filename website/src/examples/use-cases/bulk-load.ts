import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { openStorageRoot } from '@ocfl/ocfl-fs';

const catalogue: { id: string; source: string }[] = JSON.parse(await readFile('/data/catalogue.json', 'utf8'));
const user = { name: 'corpus-import', address: 'https://github.com/example/corpus-import' };

const root = await openStorageRoot('/srv/ocfl', { durability: 'none' });
for (const { id, source } of catalogue) {
  await root.create(id, { message: `Imported from ${source}`, user }, async (draft) => {
    await draft.import(source);
  });
}

// Nothing above was flushed to disk: keep every source until this returns
await promisify(execFile)('sync');
