import { isOcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/data/fedora-root').catch((error: unknown) => {
  if (isOcflError(error, 'LAYOUT_NOT_DECLARED') || isOcflError(error, 'UNSUPPORTED_LAYOUT')) {
    // The message says what the storage root declares and lists the layouts this library implements
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
});

console.log(`OCFL ${root.ocflVersion}, ${JSON.stringify(root.layout)}`);

let opened = 0;
let damaged = 0;
for await (const entry of root.objects()) {
  switch (entry.status) {
    case 'opened':
      opened++;
      break;
    case 'damaged':
      damaged++;
      console.error(`${entry.objectRoot}: ${entry.error.code} ${entry.error.ocflCode ?? ''} ${entry.error.message}`);
      break;
    default:
      console.warn('Unknown listed entry, skipped');
  }
}
console.log(`${opened} objects open, ${damaged} damaged object roots`);
