import { type OcflObject, openStorageRoot, type User } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

/** Makes the object's head hold exactly the files in `directory`. */
function deposit(id: string, directory: string, user: User): Promise<OcflObject> {
  return root.createOrUpdate(id, { message: 'Deposit', user }, async (draft) => {
    await draft.clear();
    await draft.import(directory);
  });
}

const object = await deposit('arcp://name,corpus/item/1', '/srv/uploads/item-1', { name: 'Alice' });
console.log(`${object.id} is at version ${object.head.number}`);
