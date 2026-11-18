// Run by check-package.sh from a project that installed the packed tarball
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageRoot, openStorageRoot } from '@ocfl/ocfl-fs';
import manifest from '@ocfl/ocfl-fs/package.json' with { type: 'json' };

assert.equal(manifest.name, '@ocfl/ocfl-fs', 'the package.json export resolved to the wrong manifest');

const resources = process.argv[2];

const root = join(import.meta.dirname, 'storage');
const storageRoot = await createStorageRoot(root, { layout: { extensionName: '0004-hashed-n-tuple-storage-layout' } });

const specText = 'ocfl_1.1.md';
assert((await readFile(join(root, specText))).equals(await readFile(join(resources, specText))), 'the installed package wrote the wrong specification text');

const details = { message: 'Smoke test', user: { name: 'Consumer' } };
const created = await storageRoot.create('smoke', details, async (draft) => draft.write('a.txt', 'created'));
await created.update(details, async (draft) => draft.write('a.txt', 'updated'));
const reopened = await openStorageRoot(root);
assert.equal(await (await reopened.open('smoke')).head.files.get('a.txt')?.text(), 'updated');
