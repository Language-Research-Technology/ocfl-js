import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { openStorageRoot, type StorageRoot } from '../src/index.ts';
import { createObject, DETAILS, textFiles, useTempRoots, writeB } from './helpers/drafts.ts';
import { fsError, withFsFailure } from './helpers/fs-failures.ts';

const WORKSPACE_DOC = 'ocfl-js-workspace.md';

describe('documenting the workspace in a storage root', () => {
  const roots = useTempRoots('ocfl-workspace-doc-');

  const workspaceDocOf = (root: StorageRoot) => path.join(root.path, WORKSPACE_DOC);

  /** A storage root as another tool would leave it: no workspace documentation, and the text `createStorageRoot` writes */
  async function undocumentedRoot(): Promise<{ root: StorageRoot; text: string }> {
    const root = await roots.newRoot();
    const text = await fs.promises.readFile(workspaceDocOf(root), 'utf8');
    await fs.promises.rm(workspaceDocOf(root));
    return { root, text };
  }

  it('writes the documentation when a create makes the workspace in a storage root without it', async () => {
    const { root, text } = await undocumentedRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), text);
  });

  it('writes the documentation when an update makes the workspace', async () => {
    const { root, text } = await undocumentedRoot();
    const object = await createObject(root, 'a', { 'a.txt': 'a' });
    await fs.promises.rm(workspaceDocOf(root));
    await object.update(DETAILS, writeB);
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), text);
  });

  it('writes the documentation when a purge makes the workspace', async () => {
    const { root, text } = await undocumentedRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await fs.promises.rm(workspaceDocOf(root));
    await root.purge('a');
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), text);
  });

  it('keeps documentation that is already there, even with other text', async () => {
    const { root } = await undocumentedRoot();
    await fs.promises.writeFile(workspaceDocOf(root), 'Edited by the operator\n');
    await createObject(root, 'a', { 'a.txt': 'a' });
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), 'Edited by the operator\n');
  });

  it('writes nothing when a storage root is only read', async () => {
    const { root } = await undocumentedRoot();
    await createObject(root, 'a', { 'a.txt': 'a' });
    await fs.promises.rm(workspaceDocOf(root));
    const reopened = await openStorageRoot(root.path);
    await reopened.has('a');
    await reopened.open('a');
    for await (const _ of reopened.objects()) {
    }
    for await (const _ of reopened.unfinishedWrites()) {
    }
    assert.ok(!fs.existsSync(workspaceDocOf(root)));
  });

  it('writes the documentation when several creates make the workspace at once', async () => {
    const { root, text } = await undocumentedRoot();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => createObject(root, id, { 'a.txt': id })));
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), text);
  });

  it('still creates the object when the documentation cannot be written', async () => {
    const { root } = await undocumentedRoot();
    await withFsFailure('open', workspaceDocOf(root), () => createObject(root, 'a', { 'a.txt': 'a' }), 'EACCES');
    assert.ok(!fs.existsSync(workspaceDocOf(root)));
    assert.deepStrictEqual(await textFiles((await root.open('a')).head), { 'a.txt': 'a' });
  });

  it('removes documentation it made but could not fill, so a later writer can write it', async () => {
    const { root, text } = await undocumentedRoot();
    const realOpen = fs.promises.open;
    const spy = mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen.apply(fs.promises, args);
      if (args[0] === workspaceDocOf(root)) {
        mock.method(handle, 'writeFile', async () => {
          throw fsError('ENOSPC');
        });
      }
      return handle;
    });
    try {
      await createObject(root, 'a', { 'a.txt': 'a' });
    } finally {
      spy.mock.restore();
    }
    assert.ok(!fs.existsSync(workspaceDocOf(root)));
    await createObject(root, 'b', { 'b.txt': 'b' });
    assert.strictEqual(await fs.promises.readFile(workspaceDocOf(root), 'utf8'), text);
  });
});
