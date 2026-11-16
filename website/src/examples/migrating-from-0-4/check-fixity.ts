import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

for await (const entry of root.objects()) {
  if ('error' in entry) {
    console.warn(entry.objectRoot, entry.error.code);
    continue;
  }
  for (const problem of await entry.object.checkFixity()) {
    console.warn(entry.object.id, problem.problem, problem.storedFile, problem.affects);
  }
}
