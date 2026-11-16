#!/usr/bin/env bash
# Install a packed tarball into a throwaway project and use it as a consumer would. Needs only node and npm.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tgz=$(realpath "${1:?usage: smoke-package.sh <tarball>}")
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT

fail() {
  echo "smoke-package: $*" >&2
  exit 1
}

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
node "$consumer/smoke.js" "$root/resources" || fail "the smoke test failed on Node $(node --version)"
echo "smoke-package: the packed @ocfl/ocfl-fs installs and works on Node $(node --version)"
