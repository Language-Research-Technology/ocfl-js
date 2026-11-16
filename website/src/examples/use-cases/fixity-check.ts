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

  for (const { problem, contentPath, expected, actual } of problems) {
    failures++;
    if (problem === 'missing') {
      console.error(`${object.id}: ${contentPath} is missing`);
    } else {
      console.error(`${object.id}: ${contentPath} has changed: expected ${expected}, found ${actual}`);
    }
  }
}

process.exitCode = failures > 0 ? 1 : 0;
