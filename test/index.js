const ocfl = require('ocfl-fs');

async function main() {
  const storage = ocfl.storage({ root: './data/myocfl' });
  let isValid;
  try {
    await storage.create();
  } catch (error) {
    try {
      await storage.load();
    } catch (error) {
      console.error('invalid storage root');
    }
  }
  let o = storage.object('test-object');
  if (!(await o.exists())) {
    await o.import('./v1');
  }
}

main();