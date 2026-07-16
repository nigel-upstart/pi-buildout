#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

bash -n scripts/install-extensions.sh
node --test --experimental-test-coverage extensions/*/*.test.mjs

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pushd "$tmp" >/dev/null
tarball=$(npm pack @earendil-works/pi-coding-agent@0.80.6 --silent | tail -1)
tar -xzf "$tarball"
base="$tmp/package"
package="$tmp/package-patched"
agent="$tmp/agent"
cp -R "$base" "$package"

PI_PACKAGE_DIR="$package" PI_AGENT_DIR="$agent" "$ROOT_DIR/scripts/install-extensions.sh" >/dev/null
while read -r expected file; do
  actual=$(shasum -a 256 "$package/$file" | awk '{print $1}')
  [[ "$actual" == "$expected" ]]
done < "$ROOT_DIR/patches/pi-0.80.6/patched.sha256"
[[ -f "$package/dist/core/skill-management.js" ]]
[[ -f "$agent/extensions/clear/index.ts" ]]
[[ -f "$agent/extensions/effort/helpers.ts" ]]
[[ -f "$agent/extensions/markdown-backlinks/index.ts" ]]
! find "$agent/extensions" -type f \( -name '*.test.mjs' -o -name README.md \) | grep -q .

PI_PACKAGE_DIR="$package" PI_AGENT_DIR="$agent" "$ROOT_DIR/scripts/install-extensions.sh" |
  grep -F '/skills patch for pi 0.80.6 is already applied.'

mismatch="$tmp/package-mismatch"
cp -R "$base" "$mismatch"
printf '\n// unexpected local edit\n' >> "$mismatch/dist/core/resource-loader.js"
if PI_PACKAGE_DIR="$mismatch" PI_AGENT_DIR="$tmp/mismatch-agent" "$ROOT_DIR/scripts/install-extensions.sh" >/dev/null 2>&1; then
  printf 'Expected checksum mismatch to fail.\n' >&2
  exit 1
fi
[[ ! -e "$tmp/mismatch-agent/extensions" ]]

popd >/dev/null
printf 'All quality checks passed.\n'
