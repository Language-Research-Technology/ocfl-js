import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('ocfl-root');
const object = await root.open('item-1');

console.log(`Version ${object.head.number}: ${object.head.message}`);

for (const path of object.head.files.keys()) {
  console.log(path);
}

const file = object.head.files.get('hello.txt');
if (file) {
  console.log(await file.text());
}
