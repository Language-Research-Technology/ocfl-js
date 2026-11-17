import { type FixityReport, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
// Stop the whole run after six hours, between or part way through an object
const signal = AbortSignal.timeout(6 * 60 * 60_000);
let failures = 0;

for await (const entry of root.objects()) {
  switch (entry.status) {
    case 'opened':
      break;
    case 'damaged':
      failures++;
      console.error(`${entry.objectRoot}: can't open the object (${entry.error.ocflCode ?? entry.error.code})`);
      continue;
    default:
      console.warn('Unknown listed entry, skipped');
      continue;
  }
  const { object } = entry;

  let report: FixityReport;
  try {
    report = await object.checkFixity({
      signal,
      onProgress: ({ checkedFiles, totalFiles }) => process.stderr.write(`\r${object.id}: ${checkedFiles}/${totalFiles}`),
    });
    process.stderr.write('\n');
  } catch (error) {
    if (error === signal.reason) {
      console.error(`\nOut of time: stopped at ${object.id}`);
      failures++;
      break;
    }
    // A stored file that can't be read, such as EACCES or EIO
    failures++;
    console.error(`\n${object.id}: fixity check failed`, error);
    continue;
  }

  console.log(`${object.id}: ${report.checkedFiles} stored files checked, ${report.problems.length} failed`);
  for (const { problem, storedFile, affects, expected, actual } of report.problems) {
    failures++;
    const state = problem === 'missing' ? 'is missing' : `has changed: expected ${expected}, found ${actual}`;
    const files = affects.map(({ version, path }) => `v${version}:${path}`).join(', ') || 'no file';
    console.error(`${object.id}: ${storedFile} ${state}; restore it from a backup (affects ${files})`);
  }
}

process.exitCode = failures > 0 ? 1 : 0;
