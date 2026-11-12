# pi 1.4.0 `/skills` patch

Version-specific opt-in skill activation for `@earendil-works/pi-coding-agent@1.4.0`. Configured global and trusted-project directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs \
  --version 1.4.0 --work-dir /tmp/pi-patch-1.4.0
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs \
  --version 1.4.0 --check --work-dir /tmp/pi-patch-1.4.0
```

The pinned release archive, published checksum URL, npm tarball, source revision, workspace build order, and tracked files are in [`upstream.json`](../../pi-overlay/versions/1.4.0/upstream.json). The builder reproduces all four pre-existing touched JavaScript files from pristine source before applying the overlay, enforces the measured 48-line upstream seam budget, applies the generated patch to a clean npm package, and verifies every resulting checksum. A second build with `--check` verifies byte-for-byte regeneration. Do not apply this patch to another Pi version.

- `skills.patch` changes the unbundled resource loader, CLI and interactive dispatch, and skill documentation; it adds the shared skill-management modules and replaces bundled CLI and RPC runtime entrypoints.
- `baseline.sha256` and `baseline.absent` specify the required clean state. `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` loader.
- The unchanged loader enables Node's compile cache and requires the replaced `dist/bundle/cli-runtime.js`. The `./rpc-entry` export uses the replaced `dist/bundle/rpc-entry.js`. Both wrappers reach the patched unbundled `main.js`, preserving upstream setup and arguments. This requires Node 22.19+ and a synchronous ES module graph, as upstream's loader does.
- The installer verifies baseline and result and refuses unknown or mixed states. `pre-expansion-patched.sha256` and `pre-expansion-upgrade.patch` recognize this fork's previously shipped patch and upgrade it in place. Unknown or mixed states remain rejected.

## Portable skill paths

For the one-shot CLI, quote variable-based paths so the shell does not expand them before Pi receives them, for example `pi skills add '$SKILL_ROOT/review' --global`. Interactive `/skills` arguments do not pass through a shell.

Path sources support `~`, `$NAME`, and `${NAME}`. Portable spellings expand whenever skills load or reload; unset references stay literal and produce useful diagnostics if the path cannot resolve. Checkout-local `--repo` paths persist relative to the repository root, so trusted clones and worktrees with the same remote use their own checkout. Checkout-relative entries are not activated until that checkout is trusted. Other paths retain portable spellings or persist absolute (under `~` inside the home directory); `$PWD`/`$OLDPWD` paths are frozen. Equivalent resolved paths match activation and removal. Existing absolute configuration entries are unchanged; remove and re-add to make them portable.

The migration was generated from this fork's actual pre-expansion tree, including its trust-scoped CLI behavior, not upstream's generated checksums.

## Upstream revision and provenance

Source: [earendil-works/pi](https://github.com/earendil-works/pi), tag [`v1.4.0`](https://github.com/earendil-works/pi/tree/v1.4.0), commit `4a080252f06caf63a525d7873c5d94d3c23887e0`. Declared license: MIT, copyright (c) 2025 Mario Zechner. The release tag is lightweight and its commit is unsigned. The npm registry does not publish a `gitHead`; the manifest records the tag's commit instead.

The source archive's SHA-256 is `12b14a5d812e049a0b22449e2589ee7647c31f00f93bb97d8d25aff0e71920da`, verified against both release `SHA256SUMS` and GitHub's asset digest. All 263 coding-agent source files, its skill documentation, the root package manifest and lockfile, and LICENSE were also compared with Git blob hashes from that exact tag (267 files total).

The npm archive's SHA-256 is `d155c16ef6fa00960fbf58b2911536e80b05f33700e0b14fbd08967ede0c7428`; its SHA-512 was independently checked against registry `dist.integrity`, recorded in the manifest. These are integrity checks, not a claim that the unsigned tag is authenticated.

The patch modifies upstream code and documentation, rather than taking only conceptual inspiration. It retains upstream discovery/parsing, package resolution/filtering/precedence, trust handling, reload lifecycle, CLI setup, and TUI rendering. It intentionally replaces automatic skill activation and bundled-runtime dispatch; it does not replace the package manager, parser, trust system, or extension-dialog implementation. The shared opt-in activation implementation is reused unchanged from this checkout.

## Drift from 1.3.0

- Re-read 1.4.0's resource loader, command metadata, CLI dispatch, interactive dispatch/reload, package exports, source entrypoints, and published bundled entrypoints before rebasing. The integration adds/removes the same lines as 1.3.0; only the interactive source blob hashes and two hunk positions change. The regenerated integration applies with no offset or fuzz.
- Upstream refactored extension dialogs into a stack. That moves the interactive command-dispatch and handler hunks 45 lines earlier; the `/reload` call and reload implementation used by `/skills` are unchanged. No dialog-stack code is modified by this patch.
- The resource loader, slash-command list, `main.ts`, and `docs/skills.md` are unchanged from 1.3.0. Their generated patched output, both skill-management modules, and the entrypoint wrappers are byte-identical to the 1.3.0 artifacts. Only patched `interactive-mode.js` has a different checksum.
- Upstream's workspace build now puts `packages/telemetry` before `packages/chord` and `packages/tui`; the manifest follows that order. TypeScript remains 7.0.2. All required workspace builds and both unbundled coding-agent builds succeeded.
- `src/cli.ts`, `src/cli/setup.ts`, `src/rpc-entry.ts`, and the published compile-cache loader retain the same behavior, so the wrappers are reused byte-for-byte. The pristine bundled CLI/RPC runtimes have new content-hashed chunk references and therefore new baseline hashes.
- No shared overlay or build-script changes are required.

## Runtime behavior tests

Provide a pristine package with resolvable dependencies. The retained build's baseline is `/tmp/pi-patch-1.4.0/baseline/package`; its `node_modules` symlink points to `/tmp/pi-patch-1.4.0/runtime-deps/node_modules`, installed separately with `npm ci --ignore-scripts` from the checksum-verified 1.4.0 release install manifest and lockfile. The tests copy packages before patching and never modify this baseline.

```bash
PI_SKILLS_TEST_PACKAGES=/tmp/pi-patch-1.4.0/baseline/package \
  node --test --test-name-pattern='pi 1\.4\.0' \
  scripts/skills-patch-103.test.mjs scripts/skills-patch-entrypoint.test.mjs \
  scripts/skills-patch-dispatch.test.mjs scripts/skills-catalog.test.mjs
```

The 1.4.0-only run passed all 9 tests, with no skips. It covers generated manifests and seam budget, CLI/RPC wrapper dispatch, interactive wiring, real bundled CLI catalog commands, installation, package/settings trust and precedence, concurrent persisted updates, and actual loader activation. Additional loader assertions cover default-inactive directory skills, global/repository activation with canonical upstream identity, `--no-skills` suppression of both persisted scopes, and explicit session/CLI paths surviving `--no-skills`.

The broader targeted run (the four files above plus `pi-overlay/skill-management-core.test.mjs`, `scripts/build-pi-patch.test.mjs`, and `scripts/skills-patch-packages.test.mjs`) passed 115 tests with 4 skips for unavailable pristine 1.0.4/1.1.0 packages. The pure unit/helper subset passed 76 tests with no skips. No provider inference calls were used.

Retained logs: `/tmp/pi-patch-1.4.0/build.log`, `check-build.log`, `runtime-tests.log`, `unit-tests.log`, and `targeted-tests-rerun.log`. A fresh build recreates `baseline/package`, so restore its dependency symlink before rerunning runtime tests. The patched tree is `/tmp/pi-patch-1.4.0/patched`; the generated-patch application check is `/tmp/pi-patch-1.4.0/apply-check`.
