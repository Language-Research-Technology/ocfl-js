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
import type { OcflExtension, OcflObject, OcflObjectConfig, OcflObjectInventory, OcflObjectTransaction, OcflStorage, OcflStorageLayout } from '@ocfl/ocfl';
import { extensions, OcflDigest } from '@ocfl/ocfl';
// @ts-expect-error OcflStorageImpl is not exported
import { OcflStorageImpl } from '@ocfl/ocfl';
// @ts-expect-error OcflObjectTransactionImpl is not exported
import { OcflObjectTransactionImpl } from '@ocfl/ocfl';
// @ts-expect-error RemoveOptions is gone, remove takes only a logical path
import type { RemoveOptions } from '@ocfl/ocfl';
// @ts-expect-error OcflObjectInventoryMut is not exported
import type { OcflObjectInventoryMut } from '@ocfl/ocfl';

declare const storage: OcflStorage;
declare const object: OcflObject;
declare const inventory: OcflObjectInventory;
declare const transaction: OcflObjectTransaction;
declare const extension: OcflExtension;
declare const extensionClass: typeof OcflExtension;
declare const layoutClass: typeof OcflStorageLayout;
declare const inventoryClass: typeof OcflObjectInventory;

// @ts-expect-error OcflObject.add is gone, use import
await object.add('/tmp/source');
// @ts-expect-error OcflObjectTransaction.move is gone, use rename
await transaction.move('a.txt', 'b.txt');
// @ts-expect-error OcflObjectTransaction.delete is gone, use remove
await transaction.delete('a.txt');
// @ts-expect-error OcflStorage.objects is gone, iterate the storage
storage.objects();
// @ts-expect-error OcflStorage.objectRootAbs is gone, use storage.object(id).root
storage.objectRootAbs('id');
// @ts-expect-error OcflExtension.p is gone, use parameters
extension.p;
// @ts-expect-error OcflStorage.delete is gone
storage.delete('id');
// @ts-expect-error OcflStorage.purge is gone
storage.purge('id');
// @ts-expect-error OcflDigest.digest is gone
OcflDigest.digest('sha256', 'a');
// @ts-expect-error OcflDigest.digestSync is gone
OcflDigest.digestSync('sha256', 'a');
// @ts-expect-error OcflDigest.createStream is gone
OcflDigest.createStream('sha256');
// @ts-expect-error OcflDigest.CONTENT is gone
OcflDigest.CONTENT;
// @ts-expect-error OcflObject.fileByLogicalPath is gone, use load then getFile
await object.fileByLogicalPath('a.txt');
// @ts-expect-error OcflObject.fileByDigest is gone, use load then getFile
await object.fileByDigest('abc');
// @ts-expect-error OcflObject.fileByContentPath is gone, use load then getFile
await object.fileByContentPath('v1/content/a.txt');
// @ts-expect-error OcflExtension.object is gone, use class
extensionClass.object('name');
// @ts-expect-error OcflExtension.storage is gone, use class
extensionClass.storage('name');
// @ts-expect-error OcflExtension.forObject is gone
extensionClass.forObject;
// @ts-expect-error OcflExtension.forStorage is gone
extensionClass.forStorage;
// @ts-expect-error OcflStorageLayout.forStorage is gone
layoutClass.forStorage;
// @ts-expect-error OcflExtension.minOcflVersion is gone
extension.minOcflVersion;
// @ts-expect-error OcflObjectConfig.extensions is gone
const objectConfig: OcflObjectConfig = { root: '/tmp/object', extensions: [] };
// @ts-expect-error OcflObject.digestAlgorithm has no setter, configure it when creating the object
object.digestAlgorithm = 'sha256';
// @ts-expect-error OcflObject.contentDirectory is read-only, configure it when creating the object
object.contentDirectory = 'data';
// @ts-expect-error OcflObjectTransaction.purge is gone
await transaction.purge('a.txt');
// @ts-expect-error the purge remove option is gone
await transaction.remove('a.txt', { purge: true });
// @ts-expect-error CommitOptions.force is gone
await transaction.commit({ force: true });
// @ts-expect-error OcflObjectInventory.newVersion is gone, object.update creates versions
inventoryClass.newVersion({});
// @ts-expect-error OcflObjectInventory.isChanged is gone, use diffState
inventory.isChanged;
// @ts-expect-error OcflObjectInventory.clone is gone, use new OcflObjectInventory(inv.toJSON())
inventory.clone();
// @ts-expect-error the created setter is gone
inventory.created = '2026-01-01T00:00:00Z';
// @ts-expect-error the message setter is gone
inventory.message = 'x';
// @ts-expect-error the user setter is gone
inventory.user = { name: 'x' };
// @ts-expect-error the fixity setter is gone
inventory.fixity = {};
// @ts-expect-error manifest is read-only
inventory.manifest.d = [];
// @ts-expect-error manifest entries are read-only
inventory.manifest.d!.push('x');
// @ts-expect-error versions is read-only
inventory.versions.v1!.message = 'x';
// @ts-expect-error version is read-only
inventory.version.message = 'x';
// @ts-expect-error a version's state is read-only
inventory.version.state.d!.push('x');
// @ts-expect-error state is read-only
inventory.state.d = [];
// @ts-expect-error fixity is read-only
inventory.fixity!.md5 = {};
// @ts-expect-error versionState is read-only
inventory.versionState('v1')!.d = [];
// @ts-expect-error user is read-only
inventory.user!.name = 'x';
// @ts-expect-error OcflObject.export is gone
object.export;
// @ts-expect-error extensions.DigestAlgorithm is gone
extensions.DigestAlgorithm;

export { extension, inventory, inventoryClass, object, storage, transaction };
EOF
cat >"$consumer/consumer.ts" <<'EOF'
import { join } from 'node:path';
import { type CommonHasher, implementOcfl, OcflDigest, type OcflStorage, OcflStore } from '@ocfl/ocfl';
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

const customStorage = await custom.createStorage({ root: join(import.meta.dirname, 'custom-backend'), layout: 'HashedNTupleStorageLayout' });
const customObject = customStorage.object('custom-object');
await customObject.update(async (t) => t.write('a.txt', 'written through a custom backend'));

OcflDigest.registerHasherFactory('consumer-digest', async (): Promise<CommonHasher> => {
  throw new Error('only registered, never used');
});

if (
  !(store instanceof OcflStore) ||
  custom.OCFL_VERSIONS !== ocflFs.OCFL_VERSIONS ||
  (await customObject.getFile('a.txt')?.text()) !== 'written through a custom backend' ||
  !OcflDigest.hasAlgorithm('consumer-digest') ||
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
