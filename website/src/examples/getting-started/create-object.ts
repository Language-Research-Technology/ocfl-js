import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('ocfl-root');

const details = {
  message: 'First deposit',
  user: { name: 'Alice', address: 'mailto:alice@example.org' },
};

const object = await root.create('item-1', details, async (draft) => {
  await draft.write('hello.txt', 'Hello, world');
  await draft.write('notes/field-notes.txt', 'Recorded on site');
});

console.log(object.id, object.head.number);
