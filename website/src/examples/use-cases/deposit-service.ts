import { isOcflError, type OcflObject, openStorageRoot, type User } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

/** Makes the object's head hold exactly the files in `directory`. */
async function deposit(id: string, directory: string, user: User): Promise<OcflObject> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await depositOnce(id, directory, user);
    } catch (error) {
      const raced = isOcflError(error, 'OBJECT_NOT_FOUND') || isOcflError(error, 'OBJECT_OUT_OF_DATE');
      if (!raced || attempt === 3) {
        throw error;
      }
    }
  }
}

async function depositOnce(id: string, directory: string, user: User): Promise<OcflObject> {
  try {
    return await root.create(id, { message: 'First deposit', user }, async (draft) => {
      await draft.import(directory);
    });
  } catch (error) {
    if (!isOcflError(error, 'OBJECT_EXISTS')) {
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
