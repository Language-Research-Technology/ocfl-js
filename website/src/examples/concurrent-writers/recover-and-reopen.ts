import { type Draft, OcflError, openStorageRoot, type VersionDetails } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const id = 'arcp://name,corpus/item/1';
const details: VersionDetails = { message: 'Add notes', user: { name: 'Alice' } };
const change = async (draft: Draft) => {
  await draft.write('notes.txt', 'Recorded in the field');
};

let object = await root.open(id);
const headBefore = object.head.number;

try {
  object = await object.update(details, change);
} catch (error) {
  if (!(error instanceof OcflError && error.code === 'RECOVERY_NEEDED')) {
    throw error;
  }
  // Safe only because this process is the object's one writer
  await (await root.unfinishedWrite(id))?.recover();
  object = await root.open(id);
  if (object.head.number === headBefore) {
    object = await object.update(details, change);
  }
}
