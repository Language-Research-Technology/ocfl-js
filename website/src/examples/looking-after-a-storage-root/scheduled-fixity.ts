import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { openStorageRoot } from '@ocfl/ocfl-fs';

const slices = 7;
const now = new Date();
const daysSinceEpoch = Math.floor(now.getTime() / 86_400_000);
const slice = daysSinceEpoch % slices;
// Stop before the storage gets busy again
const signal = AbortSignal.timeout(5 * 60 * 60_000);
const sliceOf = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0) % slices;

const root = await openStorageRoot('/srv/ocfl');
const findings: { where: string; problem: string }[] = [];
let checked = 0;
let outOfTime = false;

for await (const entry of root.objects()) {
  if (signal.aborted) {
    outOfTime = true;
    break;
  }
  switch (entry.status) {
    case 'opened': {
      const { object } = entry;
      if (sliceOf(object.id) !== slice) {
        break;
      }
      try {
        const report = await object.checkFixity({ signal });
        checked++;
        for (const { kind, storedFile, affects } of report.problems) {
          const files = affects.map(({ version, path }) => `v${version}:${path}`).join(', ') || 'no file';
          findings.push({ where: object.id, problem: `${storedFile} ${kind} (affects ${files})` });
        }
      } catch (error) {
        if (error === signal.reason) {
          outOfTime = true;
        } else {
          findings.push({ where: object.id, problem: `check failed: ${String(error)}` });
        }
      }
      break;
    }
    case 'damaged':
      if (sliceOf(entry.objectRoot) === slice) {
        findings.push({ where: entry.objectRoot, problem: `can't open: ${entry.error.message}` });
      }
      break;
    default:
      console.warn('Unknown listed entry, skipped');
  }
}
if (outOfTime) {
  findings.push({ where: root.path, problem: 'out of time: the rest of the slice not checked' });
}

for (const { where, problem } of findings) {
  console.error(`${where}: ${problem}`);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
await mkdir('/var/log/ocfl-fixity', { recursive: true });
await writeFile(`/var/log/ocfl-fixity/${now.toISOString()}.json`, JSON.stringify({ slice, checked, findings }, null, 2));
