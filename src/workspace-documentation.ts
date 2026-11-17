import fs from 'node:fs';
import path from 'node:path';
import { OcflConstants } from './constants.ts';
import * as fileSystem from './file-system.ts';

const { EXTENSIONS_DIR, WORKSPACE_EXTENSION, LOCK_NAME } = OcflConstants;

/** A local storage root extension, documented in the root as the OCFL spec (§4.5) allows */
const WORKSPACE_EXTENSION_TEXT = `# ${WORKSPACE_EXTENSION}

A local storage root extension used by the ocfl-js library (@ocfl/ocfl-fs).

Each object has one directory here, \`${EXTENSIONS_DIR}/${WORKSPACE_EXTENSION}/<object path>/\`, where
\`<object path>\` is the object root relative to the storage root. While the object is being created,
updated or purged, that directory holds:

- \`${LOCK_NAME}\`: the object's lock, a JSON object. \`id\` is the id of the object, \`operation\` what
  its writer is doing (\`create\`, \`update\` or \`purge\`), \`lockedAt\` the time the lock was taken
  (ISO 8601, UTC), and \`objectRootExisted\` whether the object root existed then. \`removing\`, if
  \`true\`, means a purge has begun deleting the object root. Only the writer that created the lock
  may change the object. The library never waits for a lock, and never removes one because of its
  age. A lock is written whole to a file beside it whose name starts \`.lock-\`, then put in place.
- \`<version>/\`: the new version being assembled, which is then moved into the object root.

The directories exist only while a create, update or purge is in progress. Anything left in them
afterwards is from one that was interrupted, and is not part of any OCFL object. A lock left
behind keeps the object from being updated or purged, until the library recovers the object's
unfinished write.
`;

function documentationPath(storageRoot: string): string {
  return path.join(storageRoot, `${WORKSPACE_EXTENSION}.md`);
}

/** Documents the workspace in a new storage root */
async function writeWorkspaceDocumentation(storageRoot: string): Promise<void> {
  await fileSystem.writeFile(documentationPath(storageRoot), WORKSPACE_EXTENSION_TEXT);
}

/**
 * Documents the workspace in a storage root another tool may have made, unless a file already does.
 * Any failure is ignored, since the file is only documentation, but a file this made and couldn't fill is removed.
 */
async function documentWorkspaceQuietly(storageRoot: string): Promise<void> {
  const file = documentationPath(storageRoot);
  const handle = await fs.promises.open(file, 'wx').catch(() => undefined);
  if (!handle) {
    return;
  }
  try {
    await handle.writeFile(WORKSPACE_EXTENSION_TEXT);
    await handle.close();
  } catch {
    // Already closed, or closing reported the failed write
    /* node:coverage ignore next */
    await handle.close().catch(() => {});
    await fileSystem.removeQuietly(file);
  }
}

export { documentWorkspaceQuietly, writeWorkspaceDocumentation };
