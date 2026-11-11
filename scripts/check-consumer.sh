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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OCFL_VERSIONS, storage } from '@ocfl/ocfl-fs';

const resources = process.argv[2];
const specTexts = await readdir(resources);

for (const ocflVersion of OCFL_VERSIONS) {
  const root = join(import.meta.dirname, `storage-${ocflVersion}`);
  const store = storage({ root, ocflVersion });
  await store.create({ ocflSpecText: true });

  const specText = specTexts.find((file) => file.startsWith(`ocfl_${ocflVersion}.`));
  assert(specText, `no specification text for OCFL ${ocflVersion}`);
  assert(
    (await readFile(join(root, specText))).equals(await readFile(join(resources, specText))),
    `the installed package wrote the wrong specification text for OCFL ${ocflVersion}`,
  );

  const object = store.object('smoke');
  await object.update(async (transaction) => transaction.write('a.txt', 'written'));
  await object.getInventory();
  assert.equal(await object.getFile('a.txt')?.text(), 'written');
}
EOF

pnpm -C "$consumer" install --prefer-offline --silent || fail "installing the tarball failed"
node "$consumer/smoke.js" "$root/resources" || fail "the smoke test of the installed package failed"
echo "lint:consumer: packed @ocfl/ocfl-fs passes publint and attw, installs and works"
