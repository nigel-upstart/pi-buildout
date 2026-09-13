#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"
APPLY_SKILLS_PATCH=1
EXTENSIONS=(clear effort markdown-backlinks router subagents)
# extensions/otel is the vendored OpenTelemetry fork. It stays opt-in because only one
# OpenTelemetry SDK can own a process: installing it while `npm:pi-otel` is still listed in
# settings leaves whichever loads first owning the global providers and the other disabled.
# See specs/otel-ownership-decision.md for the migration and rollback steps.
OPTIONAL_EXTENSIONS=(otel)
WITH_OTEL=0
PATCH_FILES=(
  dist/bundle/cli.js
  dist/bundle/rpc-entry.js
  dist/core/resource-loader.js
  dist/core/skill-management.js
  dist/core/slash-commands.js
  dist/main.js
  dist/modes/interactive/interactive-mode.js
  docs/skills.md
)
PATCH_STAGE_DIR=
PATCH_BACKUP_DIR=
PATCH_COMMIT_IN_PROGRESS=0
PATCH_APPLIED=()
EXTENSION_STAGE_DIR=
EXTENSION_TARGET=
EXTENSION_BACKUP=
EXTENSION_COMMIT_IN_PROGRESS=0

restore_applied_files() {
  local restored
  for restored in "${PATCH_APPLIED[@]}"; do
    if [[ -f "$PATCH_BACKUP_DIR/$restored" ]]; then
      cp -p "$PATCH_BACKUP_DIR/$restored" "$PI_PACKAGE_DIR/$restored" \
        || printf 'Could not restore %s\n' "$PI_PACKAGE_DIR/$restored" >&2
    else
      rm -f "$PI_PACKAGE_DIR/$restored" \
        || printf 'Could not remove %s during rollback\n' "$PI_PACKAGE_DIR/$restored" >&2
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ((PATCH_COMMIT_IN_PROGRESS)); then
    printf 'Interrupted while applying /skills patch; restoring replaced files.\n' >&2
    restore_applied_files
  fi
  if ((EXTENSION_COMMIT_IN_PROGRESS)); then
    if [[ ! -e "$EXTENSION_TARGET" && ! -L "$EXTENSION_TARGET" && (-e "$EXTENSION_BACKUP" || -L "$EXTENSION_BACKUP") ]]; then
      printf 'Interrupted while installing an extension; restoring %s.\n' "$EXTENSION_TARGET" >&2
      mv "$EXTENSION_BACKUP" "$EXTENSION_TARGET" || true
    fi
  fi
  [[ -z "$EXTENSION_STAGE_DIR" ]] || rm -rf "$EXTENSION_STAGE_DIR" || true
  [[ -z "$EXTENSION_BACKUP" ]] || rm -rf "$EXTENSION_BACKUP" || true
  [[ -z "$PATCH_STAGE_DIR" ]] || rm -rf "$PATCH_STAGE_DIR" || true
  [[ -z "$PATCH_BACKUP_DIR" ]] || rm -rf "$PATCH_BACKUP_DIR" || true
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap cleanup EXIT

# An extension may declare its entrypoint through the pi manifest (`pi.extensions`), which is how
# the vendored fork keeps upstream's src/ layout. Everything else uses index.ts at the root.
extension_entrypoint() {
  local manifest="$1/package.json" declared=
  if [[ -f "$manifest" ]]; then
    declared=$(node -e '
      const manifest = require(process.argv[1]);
      const declared = manifest?.pi?.extensions;
      process.stdout.write(Array.isArray(declared) && typeof declared[0] === "string" ? declared[0] : "");
    ' "$manifest")
  fi
  if [[ -z "$declared" ]]; then
    printf 'index.ts\n'
    return 0
  fi
  # Keep the declared path inside the extension directory.
  declared=${declared#./}
  if [[ "$declared" == /* || "$declared" == *..* ]]; then
    printf 'Extension %s declares an unusable entrypoint: %s\n' "$1" "$declared" >&2
    return 1
  fi
  printf '%s\n' "$declared"
}

sha256() {
  if command -v shasum > /dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum > /dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf 'A SHA-256 utility (shasum or sha256sum) is required.\n' >&2
    return 1
  fi
}

manifest_checksum() {
  awk -v file="$2" '$2 == file { print $1 }' "$1"
}

matches_checksum() {
  [[ -f "$2" && "$(sha256 "$2")" == "$1" ]]
}

find_pi_package() {
  local path package_dir
  path=$(realpath "$1" 2> /dev/null) || return 1
  # Homebrew's wrapper lives in <formula>/bin while the package is nested under
  # <formula>/libexec/lib/node_modules. Check that layout before walking parents.
  for package_dir in \
    "$(dirname "$path")/../libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
    "$(dirname "$path")/../lib/node_modules/@earendil-works/pi-coding-agent"; do
    if [[ -f "$package_dir/package.json" ]]; then
      printf '%s\n' "$(realpath "$package_dir")"
      return 0
    fi
  done
  path=$(dirname "$path")
  while [[ "$path" != / ]]; do
    if [[ -f "$path/package.json" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
    path=$(dirname "$path")
  done
  return 1
}

find_global_pi_package() {
  local npm_root package_dir
  command -v npm > /dev/null || return 1
  npm_root=$(npm root --global 2> /dev/null) || return 1
  package_dir="$npm_root/@earendil-works/pi-coding-agent"
  [[ -f "$package_dir/package.json" ]] || return 1
  printf '%s\n' "$package_dir"
}

for arg in "$@"; do
  case "$arg" in
    --skip-skill-loading-patch) APPLY_SKILLS_PATCH=0 ;;
    --with-otel) WITH_OTEL=1 ;;
    -h | --help)
      printf 'Usage: %s [--skip-skill-loading-patch] [--with-otel]\n' "$(basename "$0")"
      printf '  --with-otel  also install the vendored OpenTelemetry extension (extensions/otel).\n'
      printf '               Remove npm:pi-otel from pi settings first; two OpenTelemetry SDKs\n'
      printf '               cannot both own one process.\n'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if ((WITH_OTEL)); then
  EXTENSIONS+=("${OPTIONAL_EXTENSIONS[@]}")
fi

for extension in "${EXTENSIONS[@]}"; do
  entrypoint=$(extension_entrypoint "$ROOT_DIR/extensions/$extension")
  if [[ ! -f "$ROOT_DIR/extensions/$extension/$entrypoint" ]]; then
    printf 'Missing packaged extension entrypoint: %s\n' "$ROOT_DIR/extensions/$extension/$entrypoint" >&2
    exit 1
  fi
  # router and the vendored otel fork are multi-module trees without a helpers.ts seam.
  if [[ "$extension" != router && "$extension" != otel && ! -f "$ROOT_DIR/extensions/$extension/helpers.ts" ]]; then
    printf 'Missing packaged extension helper: %s\n' "$ROOT_DIR/extensions/$extension/helpers.ts" >&2
    exit 1
  fi
done

if ((APPLY_SKILLS_PATCH)); then
  PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-}
  if [[ -z "$PI_PACKAGE_DIR" ]]; then
    PI_BIN=$(command -v pi || true)
    if [[ -n "$PI_BIN" ]]; then
      # `pi` is commonly a symlink to <package>/dist/cli.js, so find the
      # package from its resolved entry point instead of assuming npm's bin layout.
      PI_PACKAGE_DIR=$(find_pi_package "$PI_BIN" || true)
    fi
    # Version managers such as mise can expose `pi` through a shim rather
    # than the package's CLI entrypoint. Fall back to npm's global package root.
    if [[ -z "$PI_PACKAGE_DIR" ]]; then
      PI_PACKAGE_DIR=$(find_global_pi_package || true)
    fi
  fi
  if [[ -z "$PI_PACKAGE_DIR" || ! -f "$PI_PACKAGE_DIR/package.json" ]]; then
    printf 'Could not locate pi package; install extensions only or set PI_PACKAGE_DIR.\n' >&2
    exit 1
  fi
  PI_VERSION=$(node -p 'require(process.argv[1]).version' "$PI_PACKAGE_DIR/package.json")
  PATCH_DIR="$ROOT_DIR/patches/pi-$PI_VERSION"
  PATCH_FILE="$PATCH_DIR/skills.patch"
  BASELINE_SUMS="$PATCH_DIR/baseline.sha256"
  BASELINE_ABSENT="$PATCH_DIR/baseline.absent"
  PATCHED_SUMS="$PATCH_DIR/patched.sha256"
  if [[ ! -f "$PATCH_FILE" || ! -f "$BASELINE_SUMS" || ! -f "$BASELINE_ABSENT" || ! -f "$PATCHED_SUMS" ]]; then
    printf 'No complete /skills patch exists for pi %s. Use --skip-skill-loading-patch.\n' "$PI_VERSION" >&2
    exit 1
  fi

  package_is_baseline=1
  package_is_patched=1
  for file in "${PATCH_FILES[@]}"; do
    patched_checksum=$(manifest_checksum "$PATCHED_SUMS" "$file")
    baseline_checksum=$(manifest_checksum "$BASELINE_SUMS" "$file")
    if [[ ! "$patched_checksum" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'Patched checksum manifest is invalid for %s.\n' "$file" >&2
      exit 1
    fi
    if grep -Fxq "$file" "$BASELINE_ABSENT"; then
      if [[ -n "$baseline_checksum" ]]; then
        printf 'Baseline manifests conflict for %s.\n' "$file" >&2
        exit 1
      fi
      [[ ! -e "$PI_PACKAGE_DIR/$file" && ! -L "$PI_PACKAGE_DIR/$file" ]] || package_is_baseline=0
    else
      if [[ ! "$baseline_checksum" =~ ^[0-9a-f]{64}$ ]]; then
        printf 'Baseline checksum manifest is invalid for %s.\n' "$file" >&2
        exit 1
      fi
      matches_checksum "$baseline_checksum" "$PI_PACKAGE_DIR/$file" || package_is_baseline=0
    fi
    matches_checksum "$patched_checksum" "$PI_PACKAGE_DIR/$file" || package_is_patched=0
  done

  if ((package_is_patched)); then
    APPLY_SKILLS_PATCH=0
    printf '/skills patch for pi %s is already applied.\n' "$PI_VERSION"
  elif ((!package_is_baseline)); then
    printf 'Installed pi %s does not match this patch baseline; refusing to modify it.\n' "$PI_VERSION" >&2
    exit 1
  else
    command -v patch > /dev/null || {
      printf 'The patch utility is required.\n' >&2
      exit 1
    }
    PATCH_STAGE_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-patch.XXXXXX")
    PATCH_BACKUP_DIR=$(mktemp -d "$PI_PACKAGE_DIR/.pi-skills-backup.XXXXXX")
    for file in "${PATCH_FILES[@]}"; do
      mkdir -p "$(dirname "$PATCH_STAGE_DIR/$file")" "$(dirname "$PATCH_BACKUP_DIR/$file")"
      if [[ -f "$PI_PACKAGE_DIR/$file" ]]; then
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_STAGE_DIR/$file"
        cp -p "$PI_PACKAGE_DIR/$file" "$PATCH_BACKUP_DIR/$file"
      fi
    done
    patch --batch --forward --strip=1 --directory="$PATCH_STAGE_DIR" < "$PATCH_FILE" > /dev/null
    for file in "${PATCH_FILES[@]}"; do
      patched_checksum=$(manifest_checksum "$PATCHED_SUMS" "$file")
      if ! matches_checksum "$patched_checksum" "$PATCH_STAGE_DIR/$file"; then
        printf 'Staged /skills patch produced an unexpected %s.\n' "$file" >&2
        exit 1
      fi
    done
  fi
fi

mkdir -p "$EXTENSION_DIR"
for extension in "${EXTENSIONS[@]}"; do
  EXTENSION_STAGE_DIR=$(mktemp -d "$EXTENSION_DIR/.${extension}.XXXXXX")
  entrypoint=$(extension_entrypoint "$ROOT_DIR/extensions/$extension")
  # A `package.json` travels with the extension so its runtime imports resolve outside this
  # repository, and a `package-lock.json` travels with it so the installed tree gets the exact
  # versions this repository tests. `LICENSE` and `NOTICE` travel with it because installing is
  # redistribution: the vendored Apache-2.0 source must keep its notices. `node_modules` is pruned
  # rather than copied: dependencies are installed into the staged tree below from that manifest, so
  # the installed tree never inherits this repository's development tree.
  while IFS= read -r -d '' source_file; do
    relative_file=${source_file#"$ROOT_DIR/extensions/$extension/"}
    mkdir -p "$EXTENSION_STAGE_DIR/$(dirname "$relative_file")"
    cp "$source_file" "$EXTENSION_STAGE_DIR/$relative_file"
    # `test` directories are pruned wholesale rather than relying on the `*.test.*`
    # name filter: test material that is not named that way (fixtures, helpers)
    # would otherwise be published into the installed extension.
  done < <(find "$ROOT_DIR/extensions/$extension" -name node_modules -prune -o -name dist -prune -o -name test -prune -o -type f ! -name '*.test.*' \( -name '*.ts' -o -name 'package.json' -o -name 'package-lock.json' -o -name 'LICENSE' -o -name 'LICENSE.*' -o -name 'NOTICE' -o -name 'NOTICE.*' \) -print0)

  # Runtime dependencies are installed before the atomic swap, so a failed or offline install leaves
  # the previously working extension tree in place instead of publishing one that cannot load.
  if [[ -f "$EXTENSION_STAGE_DIR/package.json" ]] && node -e 'const d = require(process.argv[1]).dependencies; process.exit(d && Object.keys(d).length > 0 ? 0 : 1)' "$EXTENSION_STAGE_DIR/package.json"; then
    # `npm ci` when a lockfile shipped: it installs the exact tree this repository tested and fails
    # rather than silently resolving something new.
    if [[ -f "$EXTENSION_STAGE_DIR/package-lock.json" ]]; then
      install_command=(npm ci --omit=dev --prefer-offline --no-audit --no-fund --ignore-scripts)
    else
      install_command=(npm install --omit=dev --prefer-offline --no-audit --no-fund --ignore-scripts)
    fi
    if ! (cd "$EXTENSION_STAGE_DIR" && "${install_command[@]}" > /dev/null); then
      printf 'Could not install runtime dependencies for %s; leaving the existing extension in place.\n' "$extension" >&2
      exit 1
    fi
    # Resolve every declared dependency the way pi will at load time, from the entrypoint that
    # imports them. A dependency that installs but does not resolve would otherwise surface as a
    # broken pi session rather than a failed install.
    # The single quotes are deliberate: ${directory} is a JavaScript template literal evaluated by
    # node, not a shell expansion.
    # shellcheck disable=SC2016
    if ! node -e '
      const { createRequire } = require("module");
      const [directory, entrypoint] = process.argv.slice(1);
      const resolver = createRequire(`${directory}/${entrypoint}`);
      for (const name of Object.keys(require(`${directory}/package.json`).dependencies)) resolver.resolve(name);
    ' "$EXTENSION_STAGE_DIR" "$entrypoint"; then
      printf 'Runtime dependencies for %s did not resolve; leaving the existing extension in place.\n' "$extension" >&2
      exit 1
    fi
  fi

  EXTENSION_TARGET="$EXTENSION_DIR/$extension"
  EXTENSION_BACKUP="$EXTENSION_STAGE_DIR.backup"
  EXTENSION_COMMIT_IN_PROGRESS=1
  if [[ -e "$EXTENSION_TARGET" || -L "$EXTENSION_TARGET" ]]; then
    mv "$EXTENSION_TARGET" "$EXTENSION_BACKUP"
  fi
  if ! mv "$EXTENSION_STAGE_DIR" "$EXTENSION_TARGET"; then
    printf 'Could not install %s; restoring its previous extension tree.\n' "$extension" >&2
    rm -rf "$EXTENSION_TARGET"
    if [[ -e "$EXTENSION_BACKUP" || -L "$EXTENSION_BACKUP" ]]; then
      mv "$EXTENSION_BACKUP" "$EXTENSION_TARGET"
    fi
    EXTENSION_COMMIT_IN_PROGRESS=0
    exit 1
  fi
  EXTENSION_STAGE_DIR=
  rm -rf "$EXTENSION_BACKUP"
  EXTENSION_BACKUP=
  EXTENSION_TARGET=
  EXTENSION_COMMIT_IN_PROGRESS=0
done

if [[ -n "$PATCH_STAGE_DIR" ]]; then
  PATCH_COMMIT_IN_PROGRESS=1
  for file in "${PATCH_FILES[@]}"; do
    # Record before rename so cleanup can recover even if interrupted immediately after it.
    PATCH_APPLIED+=("$file")
    if ! mv "$PATCH_STAGE_DIR/$file" "$PI_PACKAGE_DIR/$file"; then
      printf 'Could not apply /skills patch; restoring replaced files.\n' >&2
      restore_applied_files
      PATCH_COMMIT_IN_PROGRESS=0
      exit 1
    fi
  done
  PATCH_COMMIT_IN_PROGRESS=0
  printf 'Applied /skills patch for pi %s\n' "$PI_VERSION"
fi

printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
printf 'Destination: %s\n' "$EXTENSION_DIR"
printf 'Run /reload in an active pi session to load changes.\n'
