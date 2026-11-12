import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

for await (const object of root.objects()) {
  if (object instanceof OcflError) {
    console.warn(object.message);
    continue;
  }
  for (const problem of await object.checkFixity()) {
    console.warn(object.id, problem.problem, problem.contentPath);
  }
}
