import { type FixityProblem, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
let failures = 0;

for await (const entry of root.objects()) {
  if ('error' in entry) {
    failures++;
    console.error(`${entry.objectRoot}: can't open the object (${entry.error.ocflCode ?? entry.error.code})`);
    continue;
  }
  const { object } = entry;

  let problems: readonly FixityProblem[];
  try {
    problems = await object.checkFixity();
  } catch (error) {
    // A stored file that can't be read, such as EACCES or EIO
    failures++;
    console.error(`${object.id}: fixity check failed`, error);
    continue;
  }

  for (const { problem, storedFile, affects, expected, actual } of problems) {
    failures++;
    const state = problem === 'missing' ? 'is missing' : `has changed: expected ${expected}, found ${actual}`;
    const files = affects.map(({ version, path }) => `v${version}:${path}`).join(', ') || 'no file';
    console.error(`${object.id}: ${storedFile} ${state}; restore it from a backup (affects ${files})`);
  }
}

process.exitCode = failures > 0 ? 1 : 0;
