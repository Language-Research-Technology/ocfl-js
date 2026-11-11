#!/usr/bin/env bash
# Lint the packed tarball, then install it into a throwaway project and use it as a consumer would
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "lint:consumer: $*" >&2
  exit 1
}

pnpm -C "$root" pack --pack-destination "$tmp" >/dev/null || fail "packing failed"
tgz=$(echo "$tmp"/*.tgz)

pnpm -C "$root" exec publint run "$tgz" --strict || fail "publint rejected the tarball"
# The package is ESM-only, so the CommonJS resolutions are expected to fail
pnpm -C "$root" exec attw "$tgz" --profile esm-only || fail "attw rejected the tarball's types"

consumer=$tmp/consumer
mkdir -p "$consumer"
cat >"$consumer/package.json" <<EOF
{
  "name": "ocfl-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ocfl/ocfl-fs": "file:$tgz"
  }
}
EOF
cat >"$consumer/smoke.js" <<'EOF'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ocfl from '@ocfl/ocfl-fs';
import { createStorageRoot, OcflError, openStorageRoot } from '@ocfl/ocfl-fs';

const resources = process.argv[2];
const root = join(import.meta.dirname, 'storage');
const layout = { extensionName: '0004-hashed-n-tuple-storage-layout' };
await createStorageRoot(root, { layout });

const specText = 'ocfl_1.1.md';
assert(
  (await readFile(join(root, specText))).equals(await readFile(join(resources, specText))),
  'the installed package wrote the wrong specification text',
);
assert.equal((await openStorageRoot(root)).layout.extensionName, layout.extensionName);

assert.deepEqual(Object.keys(ocfl).sort(), ['OcflError', 'createStorageRoot', 'openStorageRoot'], 'the installed package exports something else');

const opened = await openStorageRoot(root);
const details = { message: 'Smoke test', user: { name: 'Consumer' } };
const created = await opened.create('smoke', details, async (draft) => draft.write('a.txt', 'created'));
const updated = await created.update(details, async (draft) => draft.write('a.txt', 'updated'));
assert.equal(await created.head.files.get('a.txt')?.text(), 'created');
assert.equal(await updated.head.files.get('a.txt')?.text(), 'updated');
assert.equal(await (await opened.open('smoke')).head.files.get('a.txt')?.text(), 'updated');
assert.deepEqual(await updated.checkFixity(), []);

await assert.rejects(opened.open('missing'), (error) => error instanceof OcflError && error.code === 'OBJECT_NOT_FOUND');
await opened.remove('smoke');
await assert.rejects(opened.open('smoke'), { code: 'OBJECT_NOT_FOUND' });
EOF

pnpm -C "$consumer" install --prefer-offline --silent || fail "installing the tarball failed"
node "$consumer/smoke.js" "$root/resources" || fail "the smoke test of the installed package failed"
echo "lint:consumer: packed @ocfl/ocfl-fs passes publint and attw, installs and works"
