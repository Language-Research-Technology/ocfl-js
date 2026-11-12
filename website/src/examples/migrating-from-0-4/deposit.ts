import { type Draft, OcflError, openStorageRoot, type VersionDetails } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');

const details: VersionDetails = {
  message: 'Deposit from the crate directory',
  user: { name: 'Importer', address: 'mailto:importer@example.org' },
};

async function deposit(draft: Draft) {
  await draft.clear();
  await draft.import('/data/crates/item-1');
}

const id = 'arcp://name,corpus/item/1';
try {
  const object = await root.open(id);
  await object.update(details, deposit);
} catch (error) {
  if (!(error instanceof OcflError && error.code === 'OBJECT_NOT_FOUND')) {
    throw error;
  }
  await root.create(id, details, deposit);
}
