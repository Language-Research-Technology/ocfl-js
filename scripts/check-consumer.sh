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
  "include": ["*.ts"]
}
EOF
# Typechecked but never run: each @ts-expect-error names a member that is #private
cat >"$consumer/private-members.ts" <<'EOF'
import type { OcflObject, OcflObjectTransaction } from '@ocfl/ocfl-fs';
declare const object: OcflObject;
declare const transaction: OcflObjectTransaction;
// @ts-expect-error _inventory is #private
object._inventory;
// @ts-expect-error _readInventory is #private
object._readInventory();
// @ts-expect-error _baseInventory is #private
object._baseInventory();
// @ts-expect-error _commit is #private
transaction._commit();
// @ts-expect-error _queue is #private
transaction._queue;
// @ts-expect-error _inventory is #private
transaction._inventory;
export { object, transaction };
EOF
# Typechecked but never run: each @ts-expect-error names a member that is @internal
cat >"$consumer/internal-members.ts" <<'EOF'
import type { OcflObject, OcflObjectInventory, OcflObjectTransaction } from '@ocfl/ocfl-fs';
declare const object: OcflObject;
declare const inventory: OcflObjectInventory;
declare const transactionClass: typeof OcflObjectTransaction;
// @ts-expect-error _setInventory is @internal
object._setInventory(inventory);
// @ts-expect-error _ensureNamaste is @internal
object._ensureNamaste();
// @ts-expect-error _requireInventory is @internal
object._requireInventory();
// @ts-expect-error _validateObjectPath is @internal
object._validateObjectPath();
// @ts-expect-error _digest is @internal
inventory._digest;
// @ts-expect-error _indexGet is @internal
inventory._indexGet('a');
// @ts-expect-error create is @internal
transactionClass.create(object, inventory as never, '');
export { inventory, object, transactionClass };
EOF
# Typechecked but never run: each @ts-expect-error names something that must stay out of the public API
cat >"$consumer/removed-api.ts" <<'EOF'
import type { OcflObject, OcflObjectInventory, OcflObjectTransaction, OcflStorage, OcflStorageLayout } from '@ocfl/ocfl-fs';
import * as api from '@ocfl/ocfl-fs';
// @ts-expect-error object is gone, open an object through its storage root
import { object as standaloneObject } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflObjectConfig is gone along with object
import type { OcflObjectConfig } from '@ocfl/ocfl-fs';
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
// @ts-expect-error the StorageLayout type is gone, use OcflStorageLayout
import type { StorageLayout } from '@ocfl/ocfl-fs';
// @ts-expect-error the StorageLayout export is gone, use storageLayout()
import { StorageLayout as FsStorageLayout } from '@ocfl/ocfl-fs';
// @ts-expect-error extensions is gone, use storageLayout()
import { extensions } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflExtension is gone, layouts are a fixed table
import { OcflExtension } from '@ocfl/ocfl-fs';
// @ts-expect-error the OcflExtension type is gone, layouts are a fixed table
import type { OcflExtension as OcflExtensionType } from '@ocfl/ocfl-fs';
// @ts-expect-error ExtensionConstructor is gone along with registration
import type { ExtensionConstructor } from '@ocfl/ocfl-fs';
// @ts-expect-error register is gone, layouts are a fixed table
import { register } from '@ocfl/ocfl-fs';
// @ts-expect-error setup is gone, layouts are a fixed table
import { setup } from '@ocfl/ocfl-fs';
// @ts-expect-error create is gone, use storageLayout()
import { create } from '@ocfl/ocfl-fs';
// @ts-expect-error class is gone, use storageLayout()
import { class as layoutClass } from '@ocfl/ocfl-fs';
// @ts-expect-error classes is gone, the built-in layouts are listed in OcflLayoutName
import { classes } from '@ocfl/ocfl-fs';
// @ts-expect-error the layout classes are gone, use storageLayout()
import { HashedNTupleStorageLayout } from '@ocfl/ocfl-fs';
// @ts-expect-error OcflStore is gone, the library always uses node:fs
import { OcflStore } from '@ocfl/ocfl-fs';
// @ts-expect-error implementOcfl is gone, use storage, createStorage or loadStorage
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
declare const inventoryClass: typeof OcflObjectInventory;
declare const layout: OcflStorageLayout;

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
// @ts-expect-error StorageLayout is gone from the default API, use storageLayout()
ocflFs.StorageLayout;
// @ts-expect-error extensions is gone from the default API, use storageLayout()
ocflFs.extensions;
// @ts-expect-error OcflStorageLayout is a type, use storageLayout()
api.OcflStorageLayout;
// @ts-expect-error OcflStorageLayout exposes only name, parameters and map
layout.config;
// @ts-expect-error OcflStorageLayout exposes only name, parameters and map
layout.description;
// @ts-expect-error OcflStorageLayout exposes only name, parameters and map
layout.get('tupleSize');
// @ts-expect-error OcflStorageLayout exposes only name, parameters and map
layout.version;
// @ts-expect-error OcflStorageLayout exposes only name, parameters and map
layout.set('tupleSize', 2);
// @ts-expect-error storage takes one argument
ocflFs.storage({ root: '/tmp/storage' }, {});
// @ts-expect-error object is gone from the default export
ocflFs.object({ root: '/tmp/object' });
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
// @ts-expect-error class names aren't accepted, use the official extension name
ocflFs.storage({ root: '/tmp/storage', layout: 'FlatDirectStorageLayout' });
// @ts-expect-error class names aren't accepted in a config object either
ocflFs.storage({ root: '/tmp/storage', layout: { extensionName: 'FlatDirectStorageLayout' } });
// @ts-expect-error layout objects aren't accepted, even one from storageLayout()
ocflFs.storage({ root: '/tmp/storage', layout: ocflFs.storageLayout('0002-flat-direct-storage-layout') });
// @ts-expect-error a config object has to name its layout
ocflFs.storage({ root: '/tmp/storage', layout: { tupleSize: 2 } });
// @ts-expect-error class names aren't accepted by storageLayout()
ocflFs.storageLayout('FlatDirectStorageLayout');
// @ts-expect-error a config object has to name its layout
ocflFs.storageLayout({ tupleSize: 2 });

export { SubclassedStorage, inventory, inventoryClass, layout, object, storage, transaction };
EOF
cat >"$consumer/consumer.ts" <<'EOF'
import { join } from 'node:path';
// Named so that each public export must resolve and typecheck
import ocflFs, {
  type BinaryOptions,
  type CommitOptions,
  type ContentAlgorithm,
  createStorage,
  type DeepReadonly,
  type Digests,
  type EncodingOptions,
  type FileRef,
  type FileRefContent,
  type FileRefDigest,
  type FileRefLogical,
  type FileStat,
  type HashAndIdNTupleStorageLayoutConfig,
  type HashedNTupleStorageLayoutConfig,
  type Inventory,
  type InventoryDigests,
  type InventoryFile,
  type InventoryVersion,
  loadStorage,
  type LogicalPath,
  OCFL_VERSIONS,
  ObjectNotFoundError,
  ObjectNotLoadedError,
  OcflError,
  type OcflErrorCode,
  type OcflLayoutConfig,
  type OcflLayoutName,
  type OcflObject,
  type OcflObjectFile,
  type OcflObjectInventory,
  type OcflObjectTransaction,
  type OcflStorage,
  type OcflStorageConfig,
  type OcflStorageLayout,
  type OcflVersion,
  type PathDirectStorageLayoutConfig,
  storage as openStorage,
  storageLayout,
  type UpdateMode,
  ValidationError,
  type ValidationErrorCode,
  type ValidationErrorOptions,
  type VersionNumber,
  type WriteFileData,
} from '@ocfl/ocfl-fs';

const layoutName: OcflLayoutName = '0004-hashed-n-tuple-storage-layout';
const storage: OcflStorage = await createStorage({ root: join(import.meta.dirname, 'storage'), layout: layoutName });
const layoutConfig: OcflLayoutConfig = { extensionName: '000N-path-direct-storage-layout', suffix: '/obj' };
// @ts-expect-error each layout's parameters are typed
const _wronglyTypedParameter: OcflLayoutConfig = { extensionName: '0004-hashed-n-tuple-storage-layout', tupleSize: '2' };
const configuredStorage = ocflFs.storage({ root: join(import.meta.dirname, 'configured'), layout: layoutConfig });

// @ts-expect-error OcflErrorCode is a closed union
const _unknownCode: OcflErrorCode = 'NO_SUCH_CODE';
const codeOf = (e: unknown): OcflErrorCode | undefined => (e instanceof OcflError ? e.code : undefined);
const missingCode = await storage.object('missing').files().then(() => undefined, codeOf);

for (const ocflVersion of ocflFs.OCFL_VERSIONS) {
  await ocflFs.storage({ root: join(import.meta.dirname, `spec-${ocflVersion}`), ocflVersion }).create({ ocflSpecText: true });
}

const written: OcflObject = storage.object('written-object');
await written.update(async (t: OcflObjectTransaction) => t.write('a.txt', 'written to the filesystem'));
const writtenInventory: OcflObjectInventory | undefined = await written.getInventory();
const writtenFile: OcflObjectFile | undefined = written.getFile('a.txt');

const algorithm: ContentAlgorithm | undefined = writtenInventory?.digestAlgorithm;
const fixity: Digests | undefined = writtenInventory?.getFixity('a.txt');
const writtenPath: LogicalPath = 'a.txt';
const byPath: FileRefLogical = { logicalPath: writtenPath, version: 'v1' };
const byDigest: FileRefDigest = { digest: writtenFile?.digest ?? '' };
const byContent: FileRefContent = { contentPath: writtenFile?.contentPath ?? '' };
const refs = [byPath, byDigest, byContent].map((ref) => written.getFile(ref)?.logicalPath);
const pathDirect: PathDirectStorageLayoutConfig = { suffix: '/obj' };
const hashAndId: HashAndIdNTupleStorageLayoutConfig = { tupleSize: 2, numberOfTuples: 2 };
const hashed: HashedNTupleStorageLayoutConfig = { shortObjectRoot: true };
const pathDirectLayout = storageLayout({ extensionName: '000N-path-direct-storage-layout', ...pathDirect });
const hashAndIdLayout = storageLayout({ extensionName: '0003-hash-and-id-n-tuple-storage-layout', ...hashAndId });
const hashedLayout = storageLayout({ extensionName: '0004-hashed-n-tuple-storage-layout', ...hashed });
const validationCode: ValidationErrorCode = 'E060';
const validationOptions: ValidationErrorOptions = { code: validationCode, description: 'Bad sidecar.', path: 'inventory.json.sha512' };
const validationError = new ValidationError(validationOptions);

const layout: OcflStorageLayout<'0004-hashed-n-tuple-storage-layout'> = storageLayout('0004-hashed-n-tuple-storage-layout');
const tupleSize: number = layout.parameters.tupleSize;
const declaredLayout = (): OcflLayoutName => layoutName;
const anyLayout: OcflStorageLayout = storageLayout(declaredLayout());
const _typeOnly = () => {
  // @ts-expect-error parameters are read-only
  layout.parameters.tupleSize = 2;
  // @ts-expect-error a misspelt parameter doesn't typecheck
  layout.parameters.tupleSze;
  // @ts-expect-error parameters are read through `parameters`, not get()
  layout.get('tupleSize');
  // @ts-expect-error a layout of unknown kind is narrowed by name before reading its parameters
  anyLayout.parameters.tupleSize;
};
const anyTupleSize = anyLayout.name === '0004-hashed-n-tuple-storage-layout' ? anyLayout.parameters.tupleSize : undefined;

if (
  createStorage !== ocflFs.createStorage ||
  loadStorage !== ocflFs.loadStorage ||
  openStorage !== ocflFs.storage ||
  storageLayout !== ocflFs.storageLayout ||
  OCFL_VERSIONS !== ocflFs.OCFL_VERSIONS ||
  !OCFL_VERSIONS.includes('1.1') ||
  configuredStorage.objectRoot('abc') !== 'abc/obj' ||
  tupleSize !== 3 ||
  anyTupleSize !== 3 ||
  layout.map('object-01') !== '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4' ||
  writtenInventory?.head !== 'v1' ||
  algorithm !== 'sha512' ||
  fixity === undefined ||
  refs.some((logicalPath) => logicalPath !== 'a.txt') ||
  pathDirectLayout.map('abc') !== 'abc/obj' ||
  hashAndIdLayout.parameters.tupleSize !== 2 ||
  hashedLayout.parameters.shortObjectRoot !== true ||
  validationError.code !== 'E060' ||
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
