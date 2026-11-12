import { type FixityProblem, OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
let failures = 0;

for await (const entry of root.objects()) {
  if (entry instanceof OcflError) {
    failures++;
    console.error(`Can't open an object: ${entry.message}`);
    continue;
  }

  let problems: readonly FixityProblem[];
  try {
    problems = await entry.checkFixity();
  } catch (error) {
    // A stored file that can't be read, such as EACCES or EIO
    failures++;
    console.error(`${entry.id}: fixity check failed`, error);
    continue;
  }

  for (const { problem, contentPath, expected, actual } of problems) {
    failures++;
    if (problem === 'missing') {
      console.error(`${entry.id}: ${contentPath} is missing`);
    } else {
      console.error(`${entry.id}: ${contentPath} has changed: expected ${expected}, found ${actual}`);
    }
  }
}

process.exitCode = failures > 0 ? 1 : 0;
