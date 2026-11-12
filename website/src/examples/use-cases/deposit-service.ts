import { OcflError, type OcflObject, openStorageRoot, type User } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

/** Makes the object's head hold exactly the files in `directory`. */
async function deposit(id: string, directory: string, user: User): Promise<OcflObject> {
  try {
    return await root.create(id, { message: 'First deposit', user }, async (draft) => {
      await draft.import(directory);
    });
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'OBJECT_EXISTS')) {
      throw error;
    }
  }

  const object = await root.open(id);
  return object.update({ message: 'New deposit', user }, async (draft) => {
    await draft.clear();
    await draft.import(directory);
  });
}

const object = await deposit('arcp://name,corpus/item/1', '/srv/uploads/item-1', { name: 'Alice' });
console.log(`${object.id} is at version ${object.head.number}`);
