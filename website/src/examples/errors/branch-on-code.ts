import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const id = 'item-1';

try {
  const object = await root.open(id);
  await object.update({ message: 'Add notes', user: { name: 'Alice' } }, async (draft) => {
    await draft.write('notes.txt', 'Field notes');
  });
} catch (error) {
  if (!(error instanceof OcflError)) {
    throw error;
  }
  switch (error.code) {
    case 'OBJECT_NOT_FOUND':
      console.log(`There is no object ${id}`);
      break;
    case 'UPDATE_IN_PROGRESS':
      console.log(`Another writer has held the lock since ${error.lockedAt?.toISOString() ?? 'an unknown time'}`);
      break;
    case 'INVALID_OBJECT':
      console.log(`The object is damaged (${error.ocflCode ?? 'no OCFL code'}): ${error.message}`);
      break;
    default:
      throw error;
  }
}
