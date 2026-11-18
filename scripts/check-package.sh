#!/usr/bin/env bash
# Pack and lint the tarball, then install it into a throwaway project and use it as a consumer would.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "lint:package: $*" >&2
  exit 1
}

tgz="$tmp/package.tgz"
pnpm -C "$root" pack --out "$tgz" >/dev/null || fail "packing failed"
pnpm -C "$root" exec publint run "$tgz" --strict || fail "publint rejected the tarball"
# esm-only: attw can't model require() of an ES module, which Node.js 22.12 allows (ADR 0001)
pnpm -C "$root" exec attw "$tgz" --profile esm-only || fail "attw rejected the tarball"

consumer="$tmp/consumer"
mkdir "$consumer"
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
# Copied so its import resolves from the consumer's node_modules
cp "$root/scripts/package-smoke.js" "$consumer/smoke.js"

npm --prefix "$consumer" install --no-audit --no-fund --silent || fail "installing the tarball failed"
node "$consumer/smoke.js" "$root/resources" || fail "the smoke test failed"

# Run in order from their own folder, as a reader would
cp -r "$root/website/src/examples/getting-started" "$root/website/src/examples/readme" "$consumer/"
for example in getting-started/create-storage-root getting-started/create-object getting-started/read-a-file readme/quick-start; do
  (cd "$consumer/${example%/*}" && node "${example#*/}.ts" >/dev/null) || fail "the $example example failed"
done
echo "lint:package: the packed @ocfl/ocfl-fs installs and works on Node $(node --version)"
