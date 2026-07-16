#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"
APPLY_SKILLS_PATCH=1
EXTENSIONS=(clear effort markdown-backlinks)
PATCH_FILES=(
  dist/core/resource-loader.js
  dist/core/skill-management.js
  dist/core/slash-commands.js
  dist/main.js
  dist/modes/interactive/interactive-mode.js
  docs/skills.md
)
PATCH_STAGE_DIR=
PATCH_BACKUP_DIR=

cleanup() {
  local status=$?
  [[ -z "$PATCH_STAGE_DIR" ]] || rm -rf "$PATCH_STAGE_DIR" || true
  [[ -z "$PATCH_BACKUP_DIR" ]] || rm -rf "$PATCH_BACKUP_DIR" || true
  exit "$status"
}
trap cleanup EXIT

for arg in "$@"; do
  case "$arg" in
    --skip-skill-loading-patch) APPLY_SKILLS_PATCH=0 ;;
    -h|--help)
      printf 'Usage: %s [--skip-skill-loading-patch]\n' "$(basename "$0")"
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

for extension in "${EXTENSIONS[@]}"; do
  for file in index.ts helpers.ts; do
    if [[ ! -f "$ROOT_DIR/extensions/$extension/$file" ]]; then
      printf 'Missing packaged extension file: %s\n' "$ROOT_DIR/extensions/$extension/$file" >&2
      exit 1
    fi
  done
done

if (( APPLY_SKILLS_PATCH )); then
  PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-}
  if [[ -z "$PI_PACKAGE_DIR" ]]; then
    PI_BIN=$(command -v pi || true)
    if [[ -n "$PI_BIN" ]]; then
      PI_BIN=$(realpath "$PI_BIN")
      PI_PACKAGE_DIR=$(cd "$(dirname "$PI_BIN")/../lib/node_modules/@earendil-works/pi-coding-agent" 2>/dev/null && pwd || true)
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

  for file in "${PATCH_FILES[@]}"; do
    if [[ ! -f "$PATCH_DIR/$file" ]]; then
      printf 'Patch is incomplete: %s\n' "$PATCH_DIR/$file" >&2
      exit 1
    fi
    if [[ ! -f "$PI_PACKAGE_DIR/$file" ]]; then
      printf 'Installed pi package is incomplete: %s\n' "$PI_PACKAGE_DIR/$file" >&2
      exit 1
    fi
  done

  PATCH_STAGE_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-patch.XXXXXX")
  PATCH_BACKUP_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-backup.XXXXXX")
  for file in "${PATCH_FILES[@]}"; do
    mkdir -p "$(dirname "$PATCH_STAGE_DIR/$file")" "$(dirname "$PATCH_BACKUP_DIR/$file")"
    cp -p "$PATCH_DIR/$file" "$PATCH_STAGE_DIR/$file"
    cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_BACKUP_DIR/$file"
  done
fi

mkdir -p "$EXTENSION_DIR"
for extension in "${EXTENSIONS[@]}"; do
  mkdir -p "$EXTENSION_DIR/$extension"
  cp "$ROOT_DIR/extensions/$extension/index.ts" "$EXTENSION_DIR/$extension/index.ts"
  cp "$ROOT_DIR/extensions/$extension/helpers.ts" "$EXTENSION_DIR/$extension/helpers.ts"
done

if (( APPLY_SKILLS_PATCH )); then
  applied=()
  for file in "${PATCH_FILES[@]}"; do
    if ! mv "$PATCH_STAGE_DIR/$file" "$PI_PACKAGE_DIR/$file"; then
      printf 'Could not apply /skills patch; restoring previously replaced files.\n' >&2
      for restored in "${applied[@]}"; do
        cp -p "$PATCH_BACKUP_DIR/$restored" "$PI_PACKAGE_DIR/$restored" ||
          printf 'Could not restore %s\n' "$PI_PACKAGE_DIR/$restored" >&2
      done
      exit 1
    fi
    applied+=("$file")
  done
  printf 'Applied /skills patch for pi %s\n' "$PI_VERSION"
fi

printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
printf 'Destination: %s\n' "$EXTENSION_DIR"
printf 'Run /reload in an active pi session to load changes.\n'
