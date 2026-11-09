#!/usr/bin/env bash
# Install the packed tarballs into a throwaway project, then import and typecheck them as a consumer would
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "lint:consumer: $*" >&2
  exit 1
}

# ocfl-fs builds against ocfl's dist, so ocfl packs first
for pkg in ocfl ocfl-fs; do
  pnpm -C "$root/$pkg" pack --pack-destination "$tmp/tarballs/$pkg" >/dev/null
  mkdir -p "$tmp/extract/$pkg"
  tar -xzf "$tmp/tarballs/$pkg"/*.tgz -C "$tmp/extract/$pkg"
  dir=$tmp/extract/$pkg/package

  [[ -d $dir/dist ]] || fail "@ocfl/$pkg tarball has no dist"
  srcs=$(cd "$dir" && find src -name '*.ts' ! -name '*.d.ts') || fail "@ocfl/$pkg tarball has no src"
  [[ -n $srcs ]] || fail "@ocfl/$pkg tarball has no src/*.ts"
  while IFS= read -r src; do
    base=${src#src/}
    base=${base%.ts}
    for out in "dist/$base.js" "dist/$base.d.ts"; do
      [[ -f $dir/$out ]] || fail "@ocfl/$pkg tarball is missing $out"
    done
  done <<<"$srcs"

  node -e '
    const [dir, pkg] = process.argv.slice(1);
    const { existsSync, readFileSync } = require("node:fs");
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    const targets = (e) => (typeof e === "string" ? [e] : Object.values(e ?? {}).flatMap(targets));
    const missing = targets(manifest.exports).filter((t) => !existsSync(`${dir}/${t}`));
    if (missing.length) {
      console.error(`lint:consumer: @ocfl/${pkg} exports files missing from its tarball: ${missing.join(", ")}`);
      process.exit(1);
    }
  ' "$dir" "$pkg"
done

grep -q 'workspace:' "$tmp/extract/ocfl-fs/package/package.json" && fail "packed @ocfl/ocfl-fs manifest still contains workspace:"
want="^$(node -p 'require(process.argv[1]).version' "$root/ocfl/package.json")"
got=$(node -p 'const m = require(process.argv[1]); m.dependencies?.["@ocfl/ocfl"] ? "dependency" : m.peerDependencies?.["@ocfl/ocfl"]' "$tmp/extract/ocfl-fs/package/package.json")
[[ $got == "$want" ]] || fail "packed @ocfl/ocfl-fs has @ocfl/ocfl as $got, expected a $want peer dependency"

ocfl_tgz=$(echo "$tmp/tarballs/ocfl"/*.tgz)
fs_tgz=$(echo "$tmp/tarballs/ocfl-fs"/*.tgz)
dev_dep() { node -p 'require(process.argv[1]).devDependencies[process.argv[2]]' "$root/ocfl/package.json" "$1"; }

consumer=$tmp/consumer
mkdir -p "$consumer"
cat >"$consumer/package.json" <<EOF
{
  "name": "ocfl-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ocfl/ocfl": "file:$ocfl_tgz",
    "@ocfl/ocfl-fs": "file:$fs_tgz"
  },
  "devDependencies": {
    "@types/node": "$(dev_dep @types/node)",
    "typescript": "$(dev_dep typescript)"
  }
}
EOF
cat >"$consumer/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  },
  "include": ["consumer.ts", "removed-api.ts"]
}
EOF
# Typechecked but never run: each @ts-expect-error names something that must stay out of the public API
cat >"$consumer/removed-api.ts" <<'EOF'
import type { OcflObject, OcflObjectInventory, OcflObjectTransaction, OcflStorage } from '@ocfl/ocfl';

declare const storage: OcflStorage;
declare const object: OcflObject;
declare const inventory: OcflObjectInventory;
declare const transaction: OcflObjectTransaction;

export { inventory, object, storage, transaction };
EOF
cat >"$consumer/consumer.ts" <<'EOF'
import { join } from 'node:path';
import { implementOcfl, type OcflStorage, OcflStore } from '@ocfl/ocfl';
import ocflFs, { createStorage, OcflError, type OcflErrorCode, OcflFsStore, type OcflFsStoreConfig, ValidationError } from '@ocfl/ocfl-fs';

const config: OcflFsStoreConfig = {};
const store: OcflStore = OcflFsStore.getInstance(config);
const custom = implementOcfl<OcflFsStoreConfig>(OcflFsStore);
const storage: OcflStorage = await createStorage({ root: join(import.meta.dirname, 'storage'), layout: 'HashedNTupleStorageLayout' });

// @ts-expect-error OcflErrorCode is a closed union
const _unknownCode: OcflErrorCode = 'NO_SUCH_CODE';
const codeOf = (e: unknown): OcflErrorCode | undefined => (e instanceof OcflError ? e.code : undefined);
const missingCode = await storage.object('missing').files().then(() => undefined, codeOf);

for (const ocflVersion of ocflFs.OCFL_VERSIONS) {
  await ocflFs.storage({ root: join(import.meta.dirname, `spec-${ocflVersion}`), ocflVersion }).create({ ocflSpecText: true });
}

if (
  !(store instanceof OcflStore) ||
  custom.OCFL_VERSIONS !== ocflFs.OCFL_VERSIONS ||
  (await storage.has('missing')) ||
  missingCode !== 'OBJECT_NOT_FOUND' ||
  !(ValidationError.prototype instanceof OcflError)
) {
  throw new Error('consumer check failed');
}
EOF

pnpm -C "$consumer" install --prefer-offline --silent
(cd "$consumer" && node consumer.ts) || fail "importing the packed packages failed"
for dir in "$consumer"/spec-*; do
  version=${dir##*/spec-}
  written=("$dir/ocfl_$version".*)
  cmp -s "$root/ocfl/resources/${written[0]##*/}" "${written[0]}" || fail "the packed package wrote the wrong spec text for $version"
done
pnpm -C "$consumer" exec tsc || fail "consumer.ts doesn't typecheck against the packed types"
echo "lint:consumer: packed @ocfl/ocfl and @ocfl/ocfl-fs install, import and typecheck"
