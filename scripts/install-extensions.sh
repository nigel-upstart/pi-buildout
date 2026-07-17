#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"
APPLY_SKILLS_PATCH=1

for arg in "$@"; do
  case "$arg" in
    --skip-skill-loading-patch) APPLY_SKILLS_PATCH=0 ;;
    -h | --help)
      printf 'Usage: %s [--skip-skill-loading-patch]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$EXTENSION_DIR"
for extension in clear effort markdown-backlinks; do
  mkdir -p "$EXTENSION_DIR/$extension"
  cp "$ROOT_DIR/extensions/$extension/index.ts" "$EXTENSION_DIR/$extension/index.ts"
  cp "$ROOT_DIR/extensions/$extension/helpers.ts" "$EXTENSION_DIR/$extension/helpers.ts"
done

if ((APPLY_SKILLS_PATCH)); then
  PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-}
  if [[ -z "$PI_PACKAGE_DIR" ]]; then
    PI_BIN=$(command -v pi || true)
    if [[ -n "$PI_BIN" ]]; then
      PI_BIN=$(realpath "$PI_BIN")
      PI_PACKAGE_DIR=$(cd "$(dirname "$PI_BIN")/../lib/node_modules/@earendil-works/pi-coding-agent" 2> /dev/null && pwd || true)
    fi
  fi
  if [[ -z "$PI_PACKAGE_DIR" || ! -f "$PI_PACKAGE_DIR/package.json" ]]; then
    printf 'Could not locate pi package; install extensions only or set PI_PACKAGE_DIR.\n' >&2
    exit 1
  fi
  PI_VERSION=$(node -p 'require(process.argv[1]).version' "$PI_PACKAGE_DIR/package.json")
  PATCH_DIR="$ROOT_DIR/patches/pi-$PI_VERSION"
  if [[ ! -d "$PATCH_DIR" ]]; then
    printf 'No packaged /skills patch exists for pi %s. Use --skip-skill-loading-patch.\n' "$PI_VERSION" >&2
    exit 1
  fi
  cp "$PATCH_DIR/dist/core/resource-loader.js" "$PI_PACKAGE_DIR/dist/core/resource-loader.js"
  cp "$PATCH_DIR/dist/core/skill-management.js" "$PI_PACKAGE_DIR/dist/core/skill-management.js"
  cp "$PATCH_DIR/dist/core/slash-commands.js" "$PI_PACKAGE_DIR/dist/core/slash-commands.js"
  cp "$PATCH_DIR/dist/main.js" "$PI_PACKAGE_DIR/dist/main.js"
  cp "$PATCH_DIR/dist/modes/interactive/interactive-mode.js" "$PI_PACKAGE_DIR/dist/modes/interactive/interactive-mode.js"
  cp "$PATCH_DIR/docs/skills.md" "$PI_PACKAGE_DIR/docs/skills.md"
  printf 'Applied /skills patch for pi %s\n' "$PI_VERSION"
fi

printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
printf 'Destination: %s\n' "$EXTENSION_DIR"
printf 'Run /reload in an active pi session to load changes.\n'
