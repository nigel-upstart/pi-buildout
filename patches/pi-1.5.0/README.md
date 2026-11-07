# pi 1.5.0 `/skills` patch

Version-specific opt-in skill activation for the published `@earendil-works/pi-coding-agent@1.5.0`. Configured global and trusted-project directories, packages, and settings form a catalog; only explicitly activated skills enter the prompt. The authored TypeScript lives in [`pi-overlay/`](../../pi-overlay); the patch and checksum manifests here are generated.

## Rebuild and verification

```bash
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.5.0
npm_config_registry=https://registry.npmjs.org node scripts/build-pi-patch.mjs --version 1.5.0 --check
npm test
```

The pinned release archive, published checksum, npm tarball, source revision, workspace build order, and tracked files are in [`upstream.json`](../../pi-overlay/versions/1.5.0/upstream.json). The builder compares the unmodified source build with the published runtime before generating a patch, enforces the 48-line upstream seam budget, applies the patch to a clean package, and verifies every resulting checksum. Do not apply this patch to another Pi version.

- `skills.patch` changes the unbundled resource loader, CLI and interactive dispatch, and skill documentation; it adds the shared skill-management modules and replaces bundled CLI and RPC runtime entrypoints.
- `baseline.sha256` and `baseline.absent` specify the required clean state. `patched.sha256` pins the result, including the unchanged `dist/bundle/cli.js` loader.
- The unchanged loader enables Node's compile cache and loads the replaced `dist/bundle/cli-runtime.js`; RPC uses the replaced `dist/bundle/rpc-entry.js`. The installer verifies baseline and result and refuses unknown or mixed states. There are no historical 1.5.0 patched states to migrate.

## Drift from 1.3.0

The 1.5.0 seam is the 1.3.0 seam, rebased. No overlay logic changed, and the patch makes the same 48 edited lines in the same four upstream files.

- `integration.patch` changes one line relative to 1.3.0. Upstream now imports `shortenHomePath` from `utils/paths.ts` in `interactive-mode.ts`, so the seam's import line becomes `getCwdRelativePath, resolvePath, shortenHomePath`. The edited-line count is unchanged.
- Other differences are hunk positions, context lines, and blob `index` lines. Compared with the 1.3.0 sources, upstream code added above the seams moves the two `resource-loader.ts` hunks by 5 and 32 lines, the `main.ts` dispatch hunk by 11, and the two `interactive-mode.ts` command hunks by 59 and 84. The committed 1.3.0 `integration.patch` does not apply cleanly to 1.5.0: the `paths.ts` import hunk fails, and the `slash-commands.ts` hunk and the first `interactive-mode.ts` hunk only apply with fuzz because the `/resume` description and the `source-info.ts` import changed in their context. The 1.5.0 patch is regenerated from the patched 1.5.0 sources, so it applies with no offset or fuzz.
- The upstream changes near the seams don't change skill activation: package-install failure reporting and path helpers in `resource-loader.ts`, the `/import` and `/resume` descriptions in `slash-commands.ts`, a missing-working-directory check at the start of `main()`, and extension dialog and changelog changes plus a `[Skill conflicts]` → `[Skill warnings]` label in `interactive-mode.ts`. Upstream `src/core/skills.ts` now deduplicates by resource path key, uses `isPathWithin` for source classification, and rewords one prompt line; the `loadSkills` and `loadSkillsFromDir` signatures the overlay calls are unchanged, and the build type-checks the overlay against them. Upstream `docs/skills.md` is byte-identical to 1.3.0.
- Upstream adds `packages/schema` and moves `packages/telemetry` to the front of its root `build` script. `workspaceBuildOrder` follows: `telemetry`, `schema`, `chord`, `tui`, `codemode`, `mcp`, `ai`, `durable`, `env`, `agent`.
- `src/cli.ts`, `src/rpc-entry.ts`, `src/cli/setup.ts`, and the published `dist/bundle/cli.js` loader are unchanged from 1.3.0, so the `cli-runtime.js` and `rpc-entry.js` wrappers are reused byte-for-byte. Only the baseline hashes of the bundled entrypoints differ, because upstream's content-hashed chunk names changed.
- `dist/core/skill-management.js`, `dist/core/skill-management-core.js`, and patched `docs/skills.md` are byte-identical to the 1.3.0 output.
- The npm registry publishes no `gitHead` for 1.5.0. `gitHead` is the commit that the `v1.5.0` release tag points to. That tag is lightweight and its commit is unsigned.

## Runtime behavior tests

The catalog integration suite runs against a clean, unpatched Pi package of the matching version. Pi 1.5.0 is not the repository's development dependency, so provide a clean package directory with `package.json`, `dist/`, `docs/`, and resolvable `node_modules/`:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/pi-1.5.0/package npm test
```

The directory must match the Pi 1.5.0 checksums in `baseline.sha256` and paths in `baseline.absent`. The suite copies the package to a temporary directory, applies the patch there, and exercises the CLI; it does not modify the supplied package. Multiple package directories can be separated with the platform path delimiter.

The opt-in behavior preserves explicit `--skill` with `--no-skills`, supports session/global/repository activation, and serializes persisted configuration updates. See the patched `docs/skills.md` for commands and configuration format.

To build such a package, extract the npm tarball pinned in `upstream.json` and link its `node_modules` to dependencies installed with `npm ci --ignore-scripts` from the release's `pi-coding-agent-install-package.json` and `pi-coding-agent-install-package-lock.json`. Both files are listed in the release `SHA256SUMS`.

## 1.5.0 regression checks

Pi 1.5.0 fixes three upstream behaviors that pass through the patched seams. The patch keeps each fix as upstream wrote it, and the tests below check that it still holds once the patch is applied. Assertions that depend on a 1.5.0 fix run only for Pi 1.5.0 and newer. Older versioned patches keep their own upstream behavior and run only the version-independent checks.

- **Saved project distrust (#10947).** In a project whose only project resource is `AGENTS.md`, a saved distrust decision makes both `resolveProjectTrusted` (used by `pi skills`) and the patched host's `ctx.isProjectTrusted()` report untrusted. The host is probed offline through an RPC-mode extension. A project with no saved decision stays trusted. After project `.pi/skills` and `.agents/skills` are added, `pi skills list` and `pi skills add` still exclude them. `extensions/subagents/create.test.mjs` checks that an untrusted parent launches children with `--no-approve`.
- **Skill diagnostic labels (#11521).** The overlay's unresolved-entry warning and upstream validation warnings stay warnings. A real name collision is the only collision diagnostic. Patched interactive mode labels the section `[Skill warnings]`, and the patch itself never rewrites either label.
- **Path identity (#10488).** A user skill activated by catalog name, by a symlinked alias, and as an explicit session path loads once, with no collision diagnostic. `pi-overlay/skill-management-core.test.mjs` uses Node's `path.win32` rules to check two things: the overlay's ancestor walk stops at a repo root whose drive letter is cased differently, and a user skill reached again through a differently cased walk is catalogued and activated once.

The runtime checks are in `scripts/skills-catalog.test.mjs` (`saved distrust, skill diagnostics, and path aliases survive the patched seams`):

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/pi-1.5.0/package \
  node --test --test-name-pattern='pi 1\.5\.0' scripts/skills-catalog.test.mjs
node --test pi-overlay/skill-management-core.test.mjs extensions/subagents/create.test.mjs
```

None of these upstream fixes made an overlay workaround obsolete. The overlay's own CLI and catalog trust gating, explicit skill opt-in, and the installer's realpath normalization are kept. If a later rebase finds upstream logic that duplicates an overlay workaround, remove it only as an explicit workaround removal: cite the replacing upstream fix and its minimum Pi version, and keep the behavior for older versioned patches.
