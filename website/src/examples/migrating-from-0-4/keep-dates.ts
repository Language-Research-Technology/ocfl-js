import { type OcflObject, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

// Versions exported from another system, oldest first
const history = [
  { directory: '/export/item-1/v1', message: 'Initial deposit', date: '2019-03-01T00:00:00Z' },
  { directory: '/export/item-1/v2', message: 'Corrected transcript', date: '2021-07-14T09:30:00Z' },
];
const user = { name: 'Migration', address: 'mailto:repository@example.org' };

let object: OcflObject | undefined;
for (const { directory, message, date } of history) {
  const details = { message, user, createdAt: new Date(date) };
  object = object
    ? await object.update(details, async (draft) => {
        await draft.clear();
        await draft.import(directory);
      })
    : await root.create('arcp://name,corpus/item/1', details, (draft) => draft.import(directory));
}
