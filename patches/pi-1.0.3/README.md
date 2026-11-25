# pi 1.0.3 `/skills` patch

Version-specific opt-in skill activation for the published `@earendil-works/pi-coding-agent@1.0.3`. Configured global and trusted-project directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.0.3
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.0.3 --check
npm test
```

The pinned release archive, published checksum, npm tarball, source revision, workspace build order, and tracked files are in [`upstream.json`](../../pi-overlay/versions/1.0.3/upstream.json). The builder compares the unmodified source build with the published runtime before generating a patch, enforces the 48-line upstream seam budget, applies the patch to a clean package, and verifies every resulting checksum. Do not apply this patch to another Pi version.

- `skills.patch` changes the unbundled resource loader, CLI and interactive dispatch, and skill documentation; it adds the shared skill-management modules and replaces bundled CLI and RPC runtime entrypoints.
- `baseline.sha256` and `baseline.absent` specify the required clean state. `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` loader.
- The unchanged loader enables Node's compile cache and loads the replaced `dist/bundle/cli-runtime.js`; RPC uses the replaced `dist/bundle/rpc-entry.js`. The installer verifies baseline and result and refuses unknown or mixed states. `pre-expansion-patched.sha256` and `pre-expansion-upgrade.patch` recognize this fork's previously shipped patch and upgrade it in place. Unknown or mixed states remain rejected.

## Portable skill paths

For the one-shot CLI, quote variable-based paths so the shell does not expand them before Pi receives them, for example `pi skills add '$SKILL_ROOT/review' --global`. Interactive `/skills` arguments do not pass through a shell.

Path sources support `~`, `$NAME`, and `${NAME}`. Portable spellings expand whenever skills load or reload; unset references stay literal and produce useful diagnostics if the path cannot resolve. Checkout-local `--repo` paths persist relative to the repository root, so trusted clones and worktrees with the same remote use their own checkout. Checkout-relative entries are not activated until that checkout is trusted. Other paths retain portable spellings or persist absolute (under `~` inside the home directory); `$PWD`/`$OLDPWD` paths are frozen. Equivalent resolved paths match activation and removal. Existing absolute configuration entries are unchanged; remove and re-add to make them portable.

The migration was generated from this fork's actual pre-expansion tree, including its trust-scoped CLI behavior, not upstream's generated checksums.

## Runtime behavior tests

The catalog integration suite runs against a clean, unpatched Pi package of the matching version. If Pi 1.0.3 is not installed as the repository's development dependency, provide a clean package directory with `package.json`, `dist/`, `docs/`, and resolvable `node_modules/`:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/pi-1.0.3/package npm test
```

The directory must match the Pi 1.0.3 checksums in `baseline.sha256` and paths in `baseline.absent`. The suite copies the package to a temporary directory, applies the patch there, and exercises the CLI; it does not modify the supplied package. Multiple package directories can be separated with the platform path delimiter.

The opt-in behavior preserves explicit `--skill` with `--no-skills`, supports session/global/repository activation, and serializes persisted configuration updates. See the patched `docs/skills.md` for commands and configuration format.
