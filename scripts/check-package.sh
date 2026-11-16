#!/usr/bin/env bash
# Pack and lint the tarball, then smoke-test it. Usage: check-package.sh [where to keep the tarball]
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "lint:package: $*" >&2
  exit 1
}

tgz=$(realpath -m "${1:-$tmp/package.tgz}")
pnpm -C "$root" pack --out "$tgz" >/dev/null || fail "packing failed"
pnpm -C "$root" exec publint run "$tgz" --strict || fail "publint rejected the tarball"
"$root/scripts/smoke-package.sh" "$tgz"

# Bundled apps run without the package's files beside them
tar -xzf "$tgz" -C "$tmp"
pnpm -C "$root" exec esbuild "$root/scripts/package-smoke.js" --bundle --platform=node --format=esm --log-level=warning \
  --alias:@ocfl/ocfl-fs="$tmp/package/dist/index.js" --outfile="$tmp/bundled/smoke.js" || fail "bundling the tarball failed"
(cd / && node "$tmp/bundled/smoke.js" "$root/resources") || fail "the smoke test failed bundled"
echo "lint:package: the packed @ocfl/ocfl-fs works bundled"
