import { OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const id = 'arcp://name,corpus/item/1';

for (let attempt = 1; ; attempt++) {
  const object = await root.open(id);
  try {
    await object.update({ message: 'Add notes', user: { name: 'Alice' } }, async (draft) => {
      await draft.write('notes.txt', 'Recorded in the field');
    });
    break;
  } catch (error) {
    const outOfDate = error instanceof OcflError && error.code === 'OBJECT_OUT_OF_DATE';
    if (!outOfDate || attempt === 3) {
      throw error;
    }
  }
}
