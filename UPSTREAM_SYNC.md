# Upstream sync log

This repository is a fork of [`zew1me/pi-buildout`](https://github.com/zew1me/pi-buildout). Upstream changes are ported
by cherry-picking with `git cherry-pick -x`, not by merging, so `git merge-base main zew1me/main` stays at `f7902c04`
and cannot show what has been synced. Use the last synced SHA below instead. Attribution for the ported material is
recorded in [`ATTRIBUTION.md`](ATTRIBUTION.md#zew1mepi-buildout-upstream-of-this-fork).

## Current state

| Field               | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| Upstream remote     | `zew1me` → <https://github.com/zew1me/pi-buildout.git>       |
| Upstream branch     | `main`                                                       |
| Last synced SHA     | `bc127ebf439d0827bfc4f660fdc205595caaa544` (2026-09-19, #61) |
| Last sync date      | 2026-09-22                                                   |
| Previous sync point | `57b1a5fe86c04eab65566a871c34e4bd43f3dc89` (2026-09-08, #43) |
| Sync branch         | `chore/sync-upstream-zew1me`                                 |
| Outbound fixes owed | None (see [Outbound](#outbound))                             |

To find the next batch of upstream work:

```bash
git fetch zew1me
git log --oneline bc127ebf439d0827bfc4f660fdc205595caaa544..zew1me/main
```

## 2026-09-22 sync

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

## Intentional divergences

- **Router and OpenTelemetry extensions.** The fork keeps `extensions/router` and `extensions/otel`, which upstream does
  not ship.
- **Pi development packages stay at 0.84.1.** Upstream bumps them to 0.84.4 and then 0.85.1. The router's cost tests pin
  the pi 0.84.1 model registry, and a registry bump is a separate evidence refresh. A mixed pin (only `pi-coding-agent`
  at 0.85.1) does not typecheck, because its shrinkwrapped `pi-agent-core` types conflict with the top-level copy. As a
  result, `scripts/skills-catalog.test.mjs` skips in this repository's CI. It was run and passed locally against pi
  0.85.1 during this sync.
- **Dependency overrides and scripts.** The fork keeps its own overrides and npm scripts, taking only upstream's
  `browserslist` override bump.
- **Subagent fallback effort.** The fork keeps its explicit model and effort resolution from `2d12a930` instead of
  upstream's fallback effort handling.

## Outbound

Fixes made here that should be proposed upstream: none from this sync.

- `fix(test): keep the real HOME for the installer in the catalog test` is fork-only. The fork's installer runs `npm ci`
  for the router's runtime dependencies, and with the fixture `HOME` a mise `npm` shim fails on untrusted configuration.
  Upstream's installer does not run `npm`, and its catalog test passes unchanged at `bc127ebf`.
