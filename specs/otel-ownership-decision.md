# Owning pi's OpenTelemetry export: decision record

Status: **decided — vendored fork, opt-in, downstream unchanged**. Tracks
[issue #45](https://github.com/nigel-upstart/pi-buildout/issues/45).

## Problem

Pi's OpenTelemetry export came from [`pi-otel`](https://github.com/NikiforovAll/pi-otel), pinned at `0.3.0` in
`upstart-dotfiles`. It was selected because it is the only Pi telemetry extension that implements the OTel GenAI span
model directly. That selection still holds, but it left three defects we could not fix from the outside:

1. A module-private `MAX_ATTR_BYTES = 60 * 1024` truncated every captured string, silently clipping exactly the content
   full-fidelity capture exists to collect. The SDK's `spanLimits` do not cover attributes the extension builds itself,
   so `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` could not reach it either.
2. A stale dependency train (`sdk-node@^0.57.0`, the 1.30.x line) reporting 23 findings, with no coherent override path.
3. Token-usage keys drifted from the GenAI semantic-conventions registry.

Upstream also had no CI running its tests, which made accepting a dependency migration there risky.

## Options considered

| Option                                          | Verdict                                                                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Upstream contribution**                    | Best leverage, but each fix is gated on one maintainer's response time, and the dependency migration is the largest and least reviewable of them. Still worth doing, as follow-up, from a working implementation. |
| **2. Vendored fork, pinned**                    | **Chosen.** Unblocks all three defects immediately, keeps the GenAI span model that made `pi-otel` the right choice, and gives us tests and CI on the artifact we actually run. Costs a maintenance surface.      |
| **3. Reimplement as a `pi-buildout` extension** | Rejected. We would rewrite the GenAI span tree — the package's entire value — for no gain over forking it.                                                                                                        |
| **4. Switch to `@amaster.ai/pi-telemetry`**     | Rejected. No `gen_ai.*` instrumentation in the published build and a Langfuse-oriented span model: a downgrade in convention fidelity to solve a dependency problem that the migration already solved.            |

Licensing: upstream is Apache-2.0, which permits the fork. `ATTRIBUTION.md` records the source, revision, and license;
`extensions/otel/LICENSE` retains the upstream notice; and every modified file carries a change notice, as §4(b)
requires.

Maintenance: the fork tracks upstream `0.3.0` and preserves upstream's `src/`, `test/` layout precisely so future
upstream revisions stay diffable. The root formatter, linter, knip, and typechecker exclude the directory for the same
reason.

## What the fork changes

| Defect                 | Resolution                                                                                                 | Evidence                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hard-coded 60 KiB cap  | `otel.maxAttributeBytes` / `PI_OTEL_MAX_ATTRIBUTE_BYTES`, 1 byte to 64 MiB, still defaulting to 60 KiB     | 200 KB tool result exported intact through the real SDK to an in-process OTLP receiver; still truncated at the default |
| 23 dependency findings | Whole train migrated to OTel 2.x / 0.2xx                                                                   | `npm audit --omit=dev` reports 0 findings; CI fails on high or critical                                                |
| Semconv drift          | Registry spellings for `cache_read`, `cache_creation`, `reasoning`, emitted alongside the legacy spellings | Constants asserted equal to the registry package's own exports                                                         |
| No CI                  | `otel-extension` job runs typecheck, 55 tests, and the audit gate                                          | `.github/workflows/check.yml`                                                                                          |

Two deviations are intentional and documented in `extensions/otel/README.md`: `gen_ai.usage.cache_write_input_tokens`
keeps its spelling because the registry has no cache-write attribute, and `gen_ai.system` is retained because the
registry still defines it — the concern that it had been removed does not hold.

## Why activation is opt-in

Only one OpenTelemetry SDK can own a process. With `npm:pi-otel@0.3.0` still in `settings.json`, loading the fork
produces:

```text
pi-otel: another OpenTelemetry SDK already registered global providers (trace, metrics, logs);
pi-otel telemetry is disabled for this process.
```

Whichever loads first wins and the other silently stops exporting. So `scripts/install-extensions.sh` does **not** ship
the extension by default; it requires `--with-otel`, and the two must never be enabled together. This also honors the
issue's guardrail that the `pi-otel` pin not be unpinned during exploration.

## Adoption sequence

Not yet performed. When the fork is adopted:

1. Install locally with `./scripts/install-extensions.sh --with-otel` **after** removing `npm:pi-otel@0.3.0` from
   `~/.pi/agent/settings.json`, and confirm no "another OpenTelemetry SDK" warning appears.
2. Confirm spans, metrics, and logs arrive at the staging collector, and that a tool result above 60 KiB arrives intact
   with `otel.maxAttributeBytes` raised.
3. Confirm dashboards still resolve: span names and `pi.*` attributes are unchanged, and the renamed token keys are
   dual-written.
4. Update `upstart-dotfiles` in lockstep — `pi/.pi/agent/settings.json.j2` (drop the `packages` entry, add
   `maxAttributeBytes`), `install.sh` (pass `--with-otel`), and its README.

## Rollback

Re-add `npm:pi-otel@0.3.0` to `settings.json`, remove `~/.pi/agent/extensions/otel`, and re-run the installer without
`--with-otel`. Because the fork keeps upstream's span names, `pi.*` attributes, and legacy token keys, telemetry
continuity is preserved in both directions. `otel.maxAttributeBytes` is simply ignored by the published package, which
resumes truncating at 60 KiB.

## Follow-up

Offer the configurable cap, the semconv keys, and a CI workflow upstream as separate pull requests, now that each is
implemented and tested here. The dependency migration is the most valuable to upstream and the easiest to review against
a passing test suite.
