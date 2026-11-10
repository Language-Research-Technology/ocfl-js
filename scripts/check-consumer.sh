#!/usr/bin/env bash
# Install the packed tarball into a throwaway project, then import and typecheck it as a consumer would
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "lint:consumer: $*" >&2
  exit 1
}

pnpm -C "$root" pack --pack-destination "$tmp" >/dev/null
tgz=$(echo "$tmp"/*.tgz)
tar -xzf "$tgz" -C "$tmp"
dir=$tmp/package

[[ -d $dir/dist ]] || fail "tarball has no dist"
srcs=$(cd "$dir" && find src -name '*.ts' ! -name '*.d.ts') || fail "tarball has no src"
[[ -n $srcs ]] || fail "tarball has no src/*.ts"
while IFS= read -r src; do
  base=${src#src/}
  base=${base%.ts}
  for out in "dist/$base.js" "dist/$base.d.ts"; do
    [[ -f $dir/$out ]] || fail "tarball is missing $out"
  done
done <<<"$srcs"

for spec in "$root"/resources/*; do
  [[ -f $dir/resources/${spec##*/} ]] || fail "tarball is missing the specification text ${spec##*/}"
done

node -e '
  const dir = process.argv[1];
  const { existsSync, readFileSync } = require("node:fs");
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const targets = (e) => (typeof e === "string" ? [e] : Object.values(e ?? {}).flatMap(targets));
  const missing = targets(manifest.exports).filter((t) => !existsSync(`${dir}/${t}`));
  if (missing.length) {
    console.error(`lint:consumer: exports files missing from the tarball: ${missing.join(", ")}`);
    process.exit(1);
  }
' "$dir"

dev_dep() { node -p 'require(process.argv[1]).devDependencies[process.argv[2]]' "$root/package.json" "$1"; }

consumer=$tmp/consumer
mkdir -p "$consumer"
cat >"$consumer/package.json" <<EOF
{
  "name": "ocfl-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ocfl/ocfl-fs": "file:$tgz"
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
import type { OcflExtension, OcflObject, OcflObjectConfig, OcflObjectInventory, OcflObjectTransaction, OcflStorage, OcflStorageLayout } from '@ocfl/ocfl-fs';
import * as api from '@ocfl/ocfl-fs';
import { extensions } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflDigest is gone, digest algorithms are a fixed table
import { OcflDigest } from '@ocfl/ocfl-fs';
// @ts-expect-error registerHasherFactory is gone, digest algorithms are a fixed table
import { registerHasherFactory } from '@ocfl/ocfl-fs';
// @ts-expect-error hasAlgorithm is gone, digest algorithms are a fixed table
import { hasAlgorithm } from '@ocfl/ocfl-fs';
// @ts-expect-error CommonHasher is gone along with hasher registration
import type { CommonHasher } from '@ocfl/ocfl-fs';
// @ts-expect-error MultiHasher is gone along with hasher registration
import type { MultiHasher } from '@ocfl/ocfl-fs';
// @ts-expect-error IDataType is gone along with hasher registration
import type { IDataType } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflStorageImpl is not exported
import { OcflStorageImpl } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflObjectTransactionImpl is not exported
import { OcflObjectTransactionImpl } from '@ocfl/ocfl-fs';
// @ts-expect-error RemoveOptions is gone, remove takes only a logical path
import type { RemoveOptions } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflObjectInventoryMut is not exported
import type { OcflObjectInventoryMut } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflConstants is not exported
import { OcflConstants } from '@ocfl/ocfl-fs';
// @ts-expect-error the StorageLayout type is gone, use extensions
import type { StorageLayout } from '@ocfl/ocfl-fs';
// @ts-expect-error the StorageLayout export is gone, use extensions
import { StorageLayout as FsStorageLayout } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflStore is gone, the library always uses node:fs
import { OcflStore } from '@ocfl/ocfl-fs';
// @ts-expect-error implementOcfl is gone, use storage, object, createStorage or loadStorage
import { implementOcfl } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflFsStore is gone, the library always uses node:fs
import { OcflFsStore } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflFsStoreConfig is gone along with the second argument
import type { OcflFsStoreConfig } from '@ocfl/ocfl-fs';
// @ts-expect-error ListedFile is gone along with OcflStore
import type { ListedFile } from '@ocfl/ocfl-fs';
// @ts-expect-error ListOptions is gone along with OcflStore
import type { ListOptions } from '@ocfl/ocfl-fs';
import ocflFs from '@ocfl/ocfl-fs';

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
// @ts-expect-error OcflObjectInventory.clone is gone, use inv.toJSON()
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
// @ts-expect-error OcflStorageLayout.layout is gone, use extensions
layoutClass.layout;
// @ts-expect-error StorageLayout is gone from the default API, use extensions
ocflFs.StorageLayout;
// @ts-expect-error storage takes one argument
ocflFs.storage({ root: '/tmp/storage' }, {});
// @ts-expect-error object takes one argument
ocflFs.object({ root: '/tmp/object' }, {});
// @ts-expect-error createStorage takes one argument
await ocflFs.createStorage({ root: '/tmp/storage' }, {});
// @ts-expect-error loadStorage takes one argument
await ocflFs.loadStorage({ root: '/tmp/storage' }, {});
// Through the namespace and with valid arguments, so that only a type-only export can make these fail
// @ts-expect-error OcflStorage is a type, use storage(), createStorage() or loadStorage()
new api.OcflStorage({ root: '/tmp/storage' });
// @ts-expect-error OcflStorage can't be subclassed
class SubclassedStorage extends api.OcflStorage {}
// @ts-expect-error OcflObject is a type, use object() or storage.object()
api.OcflObject;
// @ts-expect-error OcflObjectTransaction is a type, use object.update()
api.OcflObjectTransaction;
// @ts-expect-error OcflObjectInventory is a type, use object.getInventory()
api.OcflObjectInventory;
// @ts-expect-error OcflObjectFile is a type, use object.getFile() or object.files()
api.OcflObjectFile;

export { SubclassedStorage, extension, inventory, inventoryClass, object, storage, transaction };
EOF
cat >"$consumer/consumer.ts" <<'EOF'
import { join } from 'node:path';
// Named so that each public export must resolve and typecheck
import ocflFs, {
  type BinaryOptions,
  type CommitOptions,
  createStorage,
  type DeepReadonly,
  type EncodingOptions,
  extensions,
  type FileRef,
  type FileStat,
  type HashedNTupleStorageLayoutConfig,
  type Inventory,
  type InventoryDigests,
  type InventoryFile,
  type InventoryVersion,
  loadStorage,
  object,
  OCFL_VERSIONS,
  ObjectNotFoundError,
  ObjectNotLoadedError,
  OcflError,
  type OcflErrorCode,
  OcflExtension,
  type OcflExtensionConfig,
  type OcflObject,
  type OcflObjectConfig,
  type OcflObjectFile,
  type OcflObjectInventory,
  type OcflObjectTransaction,
  type OcflStorage,
  type OcflStorageConfig,
  OcflStorageLayout,
  type OcflVersion,
  type PathDirectStorageLayoutConfig,
  storage as openStorage,
  storageLayout,
  type UpdateMode,
  ValidationError,
  type VersionNumber,
  type WriteFileData,
} from '@ocfl/ocfl-fs';

const storage: OcflStorage = await createStorage({ root: join(import.meta.dirname, 'storage'), layout: 'HashedNTupleStorageLayout' });

// @ts-expect-error OcflErrorCode is a closed union
const _unknownCode: OcflErrorCode = 'NO_SUCH_CODE';
const codeOf = (e: unknown): OcflErrorCode | undefined => (e instanceof OcflError ? e.code : undefined);
const missingCode = await storage.object('missing').files().then(() => undefined, codeOf);

for (const ocflVersion of ocflFs.OCFL_VERSIONS) {
  await ocflFs.storage({ root: join(import.meta.dirname, `spec-${ocflVersion}`), ocflVersion }).create({ ocflSpecText: true });
}

const written: OcflObject = object({ root: join(import.meta.dirname, 'object'), id: 'written-object' });
await written.update(async (t: OcflObjectTransaction) => t.write('a.txt', 'written to the filesystem'));
const writtenInventory: OcflObjectInventory | undefined = await written.getInventory();
const writtenFile: OcflObjectFile | undefined = written.getFile('a.txt');

class PrefixedLayout extends extensions.FlatDirectStorageLayout {
  map(id: string) {
    return `prefix-${super.map(id)}`;
  }
}
const layoutInstance: extensions.PathDirectStorageLayout = new ocflFs.extensions.PathDirectStorageLayout();
const prefixedStorage = ocflFs.storage({ root: join(import.meta.dirname, 'prefixed'), layout: new PrefixedLayout() });

if (
  createStorage !== ocflFs.createStorage ||
  loadStorage !== ocflFs.loadStorage ||
  object !== ocflFs.object ||
  openStorage !== ocflFs.storage ||
  storageLayout !== ocflFs.storageLayout ||
  OCFL_VERSIONS !== ocflFs.OCFL_VERSIONS ||
  !OCFL_VERSIONS.includes('1.1') ||
  extensions !== ocflFs.extensions ||
  !(layoutInstance instanceof extensions.PathDirectStorageLayout) ||
  prefixedStorage.objectRoot('abc') !== 'prefix-abc' ||
  writtenInventory?.head !== 'v1' ||
  (await writtenFile?.text()) !== 'written to the filesystem' ||
  (await storage.has('missing')) ||
  missingCode !== 'OBJECT_NOT_FOUND' ||
  !(ValidationError.prototype instanceof OcflError)
) {
  throw new Error('consumer check failed');
}
EOF

pnpm -C "$consumer" install --prefer-offline --silent
(cd "$consumer" && node consumer.ts) || fail "importing the packed package failed"
for dir in "$consumer"/spec-*; do
  version=${dir##*/spec-}
  written=("$dir/ocfl_$version".*)
  cmp -s "$root/resources/${written[0]##*/}" "${written[0]}" || fail "the installed package wrote the wrong spec text for $version"
done
pnpm -C "$consumer" exec tsc || fail "consumer.ts doesn't typecheck against the packed types"
echo "lint:consumer: packed @ocfl/ocfl-fs installs, imports and typechecks"
