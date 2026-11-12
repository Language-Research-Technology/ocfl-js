import { createStorageRoot } from '@ocfl/ocfl-fs';

const root = await createStorageRoot('/srv/ocfl', {
  layout: { extensionName: '0004-hashed-n-tuple-storage-layout' },
});

const object = await root.create('greeting', { message: 'First version', user: { name: 'Alice' } }, async (draft) => {
  await draft.write('hello.txt', 'Hello, world');
});

console.log(await object.head.files.get('hello.txt')?.text());
