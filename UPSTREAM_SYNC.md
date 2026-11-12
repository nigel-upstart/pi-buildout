# Upstream sync log

This repository is a fork of [`zew1me/pi-buildout`](https://github.com/zew1me/pi-buildout). Upstream changes are ported
by cherry-picking with `git cherry-pick -x`, not by merging, so `git merge-base main zew1me/main` stays at `f7902c04`
and cannot show what has been synced. Use the last synced SHA below instead. Attribution for the ported material is
recorded in [`ATTRIBUTION.md`](ATTRIBUTION.md#zew1mepi-buildout-upstream-of-this-fork).

## Current state

| Field               | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Upstream remote     | `upstream` → <https://github.com/zew1me/pi-buildout.git>                    |
| Upstream branch     | `main`                                                                      |
| Last synced SHA     | `7965f313e6c2219a9e88310e202c6f97e0b2d431` (2026-11-11), selectively ported |
| Last sync date      | 2026-11-12                                                                  |
| Previous sync point | `867d931ee84de52e46e1b456d95338c236a804d5` (2026-09-28)                     |
| Sync branch         | `chore/sync-upstream-7965f313`                                              |
| Outbound fixes owed | None identified in this sync                                                |

To find the next batch of upstream work:

```bash
git fetch upstream
git log --oneline 7965f313e6c2219a9e88310e202c6f97e0b2d431..upstream/main
```

## 2026-11-12 selective sync (`7965f313`)

All upstream mainline commits since the previous checkpoint were compared with the fork's current implementation.
Representative equivalents are committed separately; already-present behavior is recorded rather than reintroduced.

| Upstream   | Change                                                | Disposition                                                                                                                                                 |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0ab8b5bc` | Pi 0.99.2 and 1.0.3 patches (#70)                     | 1.0.3 already in `d8231cdb` (#90); retired 0.99.2 not restored                                                                                              |
| `3b57a458` | Pi 1.0.4 patch (#71)                                  | Already in `60c5c721` (#95)                                                                                                                                 |
| `6b47f96c` | Pi 1.0.1 development minimum (#73)                    | Equivalent support update `86fae744` (#113); newer 1.3.0 pins retained                                                                                      |
| `fe4aa4bb` | Pi 1.1.0 patch (#72)                                  | Already in `cbeb426e` (#106)                                                                                                                                |
| `8993c4a1` | Retire pre-1.0.0 patches (#75)                        | Already removed by `86fae744` (#113)                                                                                                                        |
| `a5983a48` | Pi 1.3.0 patch (#77)                                  | Already in `a5edd8ba` (#126)                                                                                                                                |
| `c543eeaa` | Expand skill paths and persist portable entries (#74) | Adapted source/tests; all seven supported versions regenerated with fork-specific migrations                                                                |
| `59d2979a` | Carry path expansion into 1.3.0 (#78)                 | Included in the same representative path-behavior port; local 1.4.0/1.5.0/1.5.2 included too                                                                |
| `dabb54b1` | npm publication (#79)                                 | Selectively adapted manifest validation, script-enabled packing, verified archive publication, and consumer-archive tests; internal release policy retained |
| `e60cfcca` | Drop pre-1.0.3 support (#80)                          | Artifact retirement already equivalent; keep the fork's 1.0.1 patch-only discovery floor and 1.2.0 extension floor                                          |
| `edcd1c14` | Pi 1.4.0 patch (#82)                                  | Already in `7ef2339c` / #148; newer 1.5.0/1.5.2 support retained                                                                                            |
| `c5cb5cb4` | Legacy extension ownership (#87)                      | Existing checks retained; copied/adapted exhaustive ownership and replacement-race tests                                                                    |
| `c541ff59` | Shell-free patch application (#88)                    | Existing stdin/argument-array implementation retained; hostile-path and failure regressions ported                                                          |
| `60d9503a` | Unsampled live descendant escalation (#83)            | Equivalent in `107f1c74` (#145), including later lifecycle fixes                                                                                            |
| `f594d830` | Intended-package discovery (#86)                      | Adapted positive managed-install recognition, pointer/package version agreement, fail-closed behavior, and fixtures                                         |
| `cd2ea61a` | Pinned real-Pi RPC fixtures (#85)                     | Adapted version assertion, early cleanup, bounded tests, abort-aware waits; retained canary overrides and auth-bridge isolation                             |
| `aea28633` | RPC failure diagnostics (#84)                         | Equivalent in `0f992fbc` (#118); final-only wait behavior retained                                                                                          |
| `7965f313` | Creation without parent conversation (#89)            | Already in `fe4e325a` (#138); generic signaling and newer lifecycle safeguards retained                                                                     |

The path port preserves project-trust semantics and the 48-line runtime seam budget. Each supported version recognizes
its previously shipped patched state through `pre-expansion` manifests and upgrade patches; upstream checksum bytes were
not substituted for this fork's shipped artifacts. Regeneration checks, migration round trips, and real-package
catalog/dispatch/entrypoint suites passed for all seven versions. An existing RPC abort-race fixture was also made
explicit-control-only after the full suite exposed its 150ms auto-completion race under load; production RPC behavior
was not changed.

Public npm publication, trusted publishing/provenance, upstream scope/names, automatic version-driven releases, and
non-alpha channels are not adopted. CodeArtifact publishing remains manual and package-selective. Registry conflict,
idempotency, and backward-tag preflight from upstream are deferred: its unauthenticated public-registry lookup is not
compatible with this fork's authenticated internal registry. The selected local safeguards do not claim to make
multi-package publication atomic or to reconcile remote registry state. Separate dry runs remain previews, not approvals
bound to a later invocation's tarballs.

## 2026-10-08 supported Pi baseline (#109)

- Root Pi development packages and the vendored OTel dev pin now use 1.1.0. Router registry assertions were refreshed
  against that exact package: Azure no longer publishes GPT-5.6 Sol; the remaining required Sol routes retain their
  priced cache writes. Runtime routing policy is unchanged.
- The 1.1.0 skills patch is already included through local PR #106 (`cbeb426`), incorporating the patch from `9807b015e`
  with this fork's project-trust fix preserved.
- Installation requires Pi >=1.0.1, including extension-only installs. Managed launchers resolve through
  `install/current-version` and `install/releases/<version>/node_modules/@earendil-works/pi-coding-agent`.
- Pre-1.0.1 patch sets, overlay versions, bundled-entrypoint tests, and the old effort-picker version fallback are
  removed. Remaining exact-version skills patches are 1.0.3, 1.0.4, and 1.1.0. The earlier sync entries below are
  historical; they do not describe current supported artifacts or dev pins.

## 2026-09-29 sync (`867d931e`)

| Upstream   | Upstream change                                       | Status | Local change |
| ---------- | ----------------------------------------------------- | ------ | ------------ |
| `867d931e` | fix(patches): serialize persisted skill updates (#59) | Ported | This sync    |

Notes:

- `pi-overlay/` takes upstream's serialized skill updates, bare-name and relative-path normalization, and tests, on top
  of the fork's `commandNeedsProjectTrust` change from `4508faac`. Because the overlay therefore differs from upstream,
  the generated 0.85.1 artifacts (`skills.patch`, `patched.sha256`, and every `*-upgrade.patch`) are regenerated here
  and are not byte-identical to upstream. `pre-lock-patched.sha256` does match upstream: that state is also the 0.85.1
  patch this fork shipped from `8734f344` until `4508faac`.
- New 0.85.1 upgrade state `trust-scope-` records the fork's `4508faac` patch. New fork-only 0.87.1 upgrade state
  `trust-scope-` does the same for 0.87.1. Every migration was rebuilt from a real old tree and round-trips under
  `node scripts/build-pi-patch.mjs --all --check`.
- The 0.84.2 and 0.84.4 patch sets are removed, as upstream does.
- `scripts/skills-catalog.test.mjs` keeps the fork's per-version loop and real-`HOME` installer environment. It adds
  upstream's Git-environment isolation, path-normalization, and concurrent-update assertions, and upgrades every
  recorded state rather than only `pre-validation-` and `pre-lock-`.

## 2026-09-22 sync (`502c13a0`)

| Upstream   | Upstream change                                                  | Status | Local change |
| ---------- | ---------------------------------------------------------------- | ------ | ------------ |
| `502c13a0` | feat(patches): generate the 0.85.1 /skills patch from TypeScript | Ported | This sync    |

Notes:

- Adds `pi-overlay/` and the `patches:build` / `patches:check` generation pipeline. `patches/pi-0.85.1` files match
  upstream byte for byte.
- Lint, knip, TypeScript, lefthook, and test globs merge upstream's `pi-overlay` entries with the fork's router and
  vendored OpenTelemetry entries.

## 2026-09-22 sync (`bc127ebf`)

Upstream commits after the merge base `f7902c04`, oldest first. "Already ported" means an earlier local change brought
the same content; the file state was compared against upstream rather than relying on patch identity.

| Upstream   | Upstream change                                              | Status         | Local change                                 |
| ---------- | ------------------------------------------------------------ | -------------- | -------------------------------------------- |
| `7baf2e15` | feat(patches): add pi 0.84.1 skills patch (#30)              | Already ported | `7bca4d86` (#12), `344e8a89` (#23)           |
| `66ae8f52` | feat(patches): add pi 0.84.2 skills patch (#32)              | Already ported | `d26ce31b` (#21), `af4d6843` (#22)           |
| `f8aa3a3b` | fix(subagents): harden child protocol handling (#31)         | Already ported | `166b8ecb`, merged by `61c360f1`             |
| `fc207308` | fix(patches): reject extra arguments to /skills reload (#36) | Already ported | `eaef268d`                                   |
| `57b1a5fe` | fix(deps): remediate new audit advisories (#43)              | Equivalent     | `7bcdf23a` (independent remediation)         |
| `34476e01` | fix(patches): include package and settings skills (#39)      | Ported         | This sync                                    |
| `0113bf3a` | feat(patches): add Pi 0.84.4 skills patch (#44)              | Ported, merged | This sync; the pi dev package bump not taken |
| `f082c414` | feat(patches): add pi 0.85.1 skills patch (#42)              | Ported, merged | This sync; supersedes the local 0.85.1 patch |
| `a4bb5d06` | fix(patches): migrate historical pi 0.85.1 state (#60)       | Ported         | This sync                                    |
| `bc127ebf` | fix(installer): retire legacy extension entrypoints (#61)    | Ported         | This sync                                    |

Notes:

- Upstream #42 replaces this repository's earlier `patches/pi-0.85.1` set. Its `legacy-patched.sha256` matches the
  earlier local `patched.sha256` plus the clean bundled entrypoints, so installs patched from this repository are
  recognized and upgraded instead of rejected. All `patches/` files match upstream byte for byte.
- `scripts/install-extensions.sh` takes upstream's manifest-driven patch file set, upgrade manifests, Homebrew lookup,
  and legacy entrypoint cleanup. It keeps the fork's `router` extension, the opt-in `--with-otel` extension, and
  manifest-declared entrypoints.

### Follow-up: pi 0.85.1 development packages (#64)

The pi 0.84.4 and 0.85.1 development package bumps from upstream #44 and #42 were held back in this sync, because the
router's cost tests pin the model registry. Issue #64 bumps all four `@earendil-works/*` development packages to 0.85.1
and re-pins the router tests after an evidence review, recorded in
[`specs/routing-layer/registry-refresh-2026-09-22.md`](specs/routing-layer/registry-refresh-2026-09-22.md). The fork now
matches upstream's development package versions, and `scripts/skills-catalog.test.mjs` runs in CI. The vendored
`extensions/otel` package keeps its own `pi-coding-agent` 0.84.1 development pin, which upstream does not carry.

## Intentional divergences

- **Router and OpenTelemetry extensions.** The fork keeps `extensions/router` and `extensions/otel`, which upstream does
  not ship.
- **Dependency overrides and scripts.** The fork keeps its own overrides and npm scripts, taking only upstream's
  `browserslist` override bump.
- **Subagent fallback effort.** The fork keeps its explicit model and effort resolution from `2d12a930` instead of
  upstream's fallback effort handling.

## Outbound

Fixes made here that should be proposed upstream: none from this sync.

- `fix(test): keep the real HOME for the installer in the catalog test` is fork-only. The fork's installer runs `npm ci`
  for the router's runtime dependencies, and with the fixture `HOME` a mise `npm` shim fails on untrusted configuration.
  Upstream's installer does not run `npm`, and its catalog test passes unchanged at `bc127ebf`.
