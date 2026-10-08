# Effect v4 adoption: evaluation and Phase 0

Status: **proposed — bounded pilot recommended, broad adoption rejected**. Analysed 2026-10-08 against `origin/main` at
`b99cd68`. Tracked by Traffic Control session `9708a77d` in `sardine-run-stack`. Source research: the vault note
`resources/research/effect-v4-when-to-use.md`, whose sources are listed at the end of this record.

## Question

Should pi-buildout adopt Effect v4 (`effect@4.0.2`, the current `latest`, MIT) for its TypeScript extensions, and if so,
which single piece of code should carry Phase 0?

## Verdict

1. **Worth a bounded pilot. Not worth an adoption program.** The code has a real, concentrated need for structured
   timeouts, cancellation, and cleanup. It does not have the broad retry, dependency-injection, or error-channel
   problems that would justify the whole model across every extension.
2. **Phase 0 is the classifier stage deadline runner** (`runClassifierInvocation`,
   [`extensions/router/telemetry.ts:171`](../extensions/router/telemetry.ts)). It is the one place where timeouts, abort
   propagation, and timer cleanup must be right, and it already has an 11-test oracle (8 direct tests in
   `telemetry.test.mjs`, 3 in `index.test.mjs`). It has **no** timer seam today: it calls the global `setTimeout` and
   `clearTimeout` directly, so Phase 0 adds one. It is also on the live turn path, so Phase 0 is built to be switched
   off, not assumed safe.
3. **Effect must be loaded lazily.** Importing `effect` costs far more than the 25 ms first proposed (see
   [Startup and size measurement](#startup-and-size-measurement)). Phase 0 is only acceptable if the flag-off path never
   loads Effect, and the flag-on path imports subpath modules only.

## Evidence from the code

Measured on `origin/main` (non-test TypeScript only; counts are approximate).

| Area                                                      | What is hand-rolled                                                                                                                                                                                                         | Effect fit                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `router/telemetry.ts` `runClassifierInvocation` (171–290) | Overall and per-stage `setTimeout`s on the global timer, `AbortController` abort on overrun, a `Settled` race between result, error, and deadline, and timer clearing after the race. No injectable clock.                  | **High.** This is the timeout/abort/race structure Effect expresses directly (`Effect.timeout`, `Effect.race`, interruption). |
| `router/telemetry.ts` `JsonlTelemetryStore` append        | A 250 ms append timeout behind an injected `deadline` adapter (`set`/`clear`, ~570). This is the only injected timer seam in the router today.                                                                              | Low. Best-effort persistence; the existing seam is the pattern Phase 0 copies.                                                |
| `router/index.ts` grace timers (~1150–1175)               | Grace-period `setTimeout` with a resolve-or-timeout race.                                                                                                                                                                   | Medium. Would move with Phase 0 only if it shares the same helper.                                                            |
| `router/pi-classifier.ts` endpoint fallthrough (~110–210) | Any thrown error falls through to the next endpoint; cancellation is the single exception. This is an error-classification rule written as an `if`.                                                                         | Medium. Typed errors make the cancellation exception explicit. Small code, so low payoff alone.                               |
| `subagents/rpc.ts` termination (~400–740)                 | Pending-request timers, a SIGTERM → poll → SIGKILL → terminal-cleanup state machine using `setInterval`, `setTimeout`, and Windows `taskkill` counters, plus a process-tree monitor.                                        | **High in principle, highest risk in practice** (process trees, cross-platform). Phase 1 at the earliest.                     |
| `router/core/fallback.ts`, `routing.ts`, lease state      | Pure policy functions with unit tests. Issue #100 proposes moving lease state into an `xstate` machine with `fast-check` race tests (branch `feat/100-router-lease-machine`, unmerged); neither library is on `main` today. | **Low.** Pure functions need no runtime, and Effect would compete with the `xstate` direction in #100. Not adopted.           |

Other facts that bear on the decision:

- **Retries are not a general layer here.** The 24 `retry|backoff` hits are mostly routing-economics terms (`retryCost`,
  `probabilityRetry`), not retry loops. The only retry-like behaviour is the classifier fallthrough above. Effect's
  `Schedule` would replace very little today.
- **DI already exists in manual form.** Per-module seams such as the `JsonlTelemetryStore` `deadline` and `persist`
  options are a small, hand-written version of what `Context`/`Layer` provide. That lowers the value of a repo-wide DI
  migration.
- **Scale.** The router is ~14.7k non-test lines of TypeScript and the subagent extension ~1.9k. Both are large enough
  for timer and cancellation bugs to matter, and not so large that a single pilot module is hard to review.
- **Dependency precedent.** `extensions/router/package.json` already ships runtime dependencies (`shell-quote`, `shlex`)
  that the installer materialises next to the extension; #100 proposes adding `xstate` the same way. Adding `effect`
  there follows an existing path rather than inventing one. The `otel` fork carries its own manifest for the same
  reason.
- **Toolchain.** Root `typescript` is `^5.9.3`, which meets Effect v4's stated floor.

## Startup and size measurement

Measured 2026-10-08 to answer open question 2 before the spike.

| Import                                                                                 | p50 added | p90 added |
| -------------------------------------------------------------------------------------- | --------- | --------- |
| Barrel: `import "effect"`                                                              | ~153 ms   | ~163 ms   |
| Subpath: `import "effect/Effect"`                                                      | ~41 ms    | ~46 ms    |
| Phase 0 shape: `effect/Effect` + `Effect.tryPromise` + `Effect.timeout` + `runPromise` | ~43 ms    | ~45 ms    |
| Baseline (no import)                                                                   | ~2 ms     | ~2 ms     |

- **Method.** `effect@4.0.2` installed alone into a scratch directory. Each case ran in 41 fresh Node processes; the
  probe timed `await import(spec)` with `performance.now()` and the table reports the added time over the baseline. Node
  v22.23.0 on an EC2 Intel Xeon Platinum 8488C (8 vCPU). This is not the reference machine, and it measures the cost of
  loading Effect, not the router extension's own module load.
- **Size.** `effect@4.0.2` has no runtime dependencies but is ~50 MB unpacked (55 MB `node_modules`), and the installer
  would copy it next to the router extension for every user.
- **Finding.** Both import shapes fail the 25 ms threshold this record first proposed. Instead of raising the threshold,
  the scope changes: the flag-off path must not load Effect at all (dynamic `import("effect/Effect")` inside the flag-on
  branch), so default startup is unchanged by design. The flag-on cost, about 43 ms once on the first classifier call,
  is on the turn path and becomes its own gate below. Barrel imports from `effect` are not allowed.

Probe used (rerun it on the reference machine before the spike PR):

```sh
cat > probe.mjs << 'EOF'
const spec = process.argv[2];
const t0 = performance.now();
if (spec !== "none") await import(spec);
process.stdout.write(String(performance.now() - t0));
EOF
for spec in none effect effect/Effect; do
  for i in $(seq 1 41); do
    node probe.mjs "$spec"
    echo
  done | sort -n | sed -n '21p;37p'
done
```

## Why it is worth a pilot

- **The failure modes are the kind Effect makes structural.** The deadline runner has to abort the in-flight request,
  discard a result that arrives after the deadline, and clear every timer on every path. Those invariants are currently
  enforced by careful code and tests. Effect's interruption and finalizers make them part of the program's shape.
- **Tests can get stronger.** The same invariants can be asserted directly: the abort signal reached the request, a late
  result was ignored, and no timer outlived the invocation. Today the tests use real timers with short budgets, because
  the function has no clock seam.
- **Adoption can be incremental.** One module, one exported function, and an `Effect.tryPromise` boundary around the
  existing Promise-based `invoke`. Nothing above the function changes; both production call sites (`index.ts:322`,
  `index.ts:1024`) keep the same signature.
- **The cost of finding out is bounded.** The change is one module plus one manifest entry, and it is reversible with a
  flag and a revert.

## Why it is not worth broad adoption now

- **The Pi extension API is Promise and callback based.** Every hook (`pi.on`, tool execution, RPC) needs a boundary.
  The research note's warning applies directly: typed-error guarantees weaken when a codebase mixes Effect and plain
  Promise code inconsistently.
- **The routing core does not need it.** Policy is pure functions, and the lease-state direction in #100 is `xstate`.
  Effect would add a second state and concurrency vocabulary rather than improve either.
- **Shipping a runtime library into every user's Pi install is a measured cost.** ~41–153 ms to load and ~50 MB on disk
  (see [Startup and size measurement](#startup-and-size-measurement)). A repo-wide adoption could not be lazy-loaded the
  way one flagged function can.
- **Effect v4 is recent.** `4.0.0` is only a few releases old in the registry. We have no measured stability history for
  the v4 API, so the pilot must pin an exact version.
- **The benefit claims are unverified here.** The "built for the AI era" framing in the vendor docs is marketing. We
  have no measurement of agent productivity or error reduction in this repo, and this evaluation does not rely on one.
- **Learning cost.** The research note estimates a few focused days. On a repo with one primary maintainer, that cost
  should buy a concrete result before it is spread.

## Candidate comparison for Phase 0

| Candidate                                             | Effect fit | Blast radius                                                                                   | Oracle                                               | Seam                                      | Decision                                      |
| ----------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Classifier stage deadline (`runClassifierInvocation`) | High       | Medium. On the turn path; a timeout keeps the current model, a bug could hang or cancel early. | `telemetry.test.mjs` (8 tests), `index.test.mjs` (3) | `invoke` callback only; timers are global | **Phase 0**                                   |
| Classifier endpoint fallthrough (`pi-classifier.ts`)  | Medium     | Medium. Changes which endpoint answers.                                                        | `pi-classifier.test.mjs`                             | Partial                                   | Phase 0 runner-up; revisit after Phase 0 gate |
| Subagent RPC termination (`subagents/rpc.ts`)         | High       | High. Process trees, Windows `taskkill`, user-visible kill semantics.                          | `rpc.test.mjs`, `mock-rpc-child.mjs`                 | Partial                                   | Phase 1, conditional                          |
| Lease, fallback, routing policy                       | Low        | High. Core decisions.                                                                          | Unit tests; `fast-check` proposed in #100            | Pure functions                            | Not adopted                                   |
| Telemetry JSONL persistence                           | Low        | Low                                                                                            | `telemetry.test.mjs`                                 | Injected `deadline` and `persist`         | Not adopted                                   |

**Why the classifier deadline runner is Phase 0, and why not the others:**

- It is the **only candidate where Effect's core features map one-to-one onto the existing code**: timeout, abort, race,
  and cleanup. The fallthrough rule needs typed errors but little else, so it would not exercise the model.
- Its blast radius is **real but containable**. A flag can keep the current implementation as the default until the gate
  passes, and the lazy import keeps the default path free of the new dependency. The subagent termination code cannot be
  contained that way: it cleans up child processes, and a faulty version can leave orphaned processes on Windows or
  macOS.
- It has the **strongest existing oracle**: eleven tests that already pin stage budgets, abort, and outcome
  categorisation through the public signature, so parity is checkable without a live model.
- Doing it first also **proves the packaging path** (a new runtime dependency in `extensions/router/package.json`,
  materialised by the installer, audited by `npm run audit`). That is the most likely source of surprise, and it is
  cheap to learn on a small change.
- The subagent termination code is the **better long-term target**, but it should only be attempted once Phase 0 has
  shown the packaging, test, and startup costs are acceptable.

## Phase 0 scope

Scope is **one function** plus the packaging it needs.

1. Add `effect` pinned to an exact version (`4.0.2` at analysis time) to `extensions/router/package.json`. Do not add it
   to the root manifest. Regenerate the lockfile through the extension's own install path.
2. Add an optional timer seam to `runClassifierInvocation`, modelled on the `JsonlTelemetryStore` `deadline` option
   (`set`/`clear`, defaulting to the global timers). Land it first, on its own, with the flag-off implementation, so the
   existing tests prove the seam changes nothing.
3. Implement an Effect-backed deadline and abort path in a sibling module. It must keep the same exported signature, the
   same timer seam, and the same `summary` shape. Import subpath modules only (`effect/Effect` and the like), never the
   `effect` barrel.
4. Select the implementation with a single setting, default **off** (the existing `Promise` implementation remains the
   default). Use either an environment variable or the existing router config, not both. Load the sibling module with a
   dynamic `import()` inside the flag-on branch, so a flag-off session never loads Effect.
5. Bridge the existing `AbortSignal` into Effect at the boundary (`Effect.tryPromise` with the signal) so network
   cancellation still reaches the transport.

### Acceptance gates

**Before merge:**

- The 8 `runClassifierInvocation` tests in `extensions/router/telemetry.test.mjs` and the 3 in
  `extensions/router/index.test.mjs` pass **unchanged** with the flag off, and with the flag on.
- New tests assert, for the Effect path: an overrunning stage aborts the signal passed to `invoke`; a result that
  arrives after the deadline is discarded; the timer seam's `clear` is called for every timer that was set, on every
  completion path including cancellation. Use the seam from scope item 2, `node:test` `mock.timers`, or Effect's
  `TestClock`, whichever the spike shows is simplest.
- A test proves that with the flag off, importing the router extension does not load any `effect` module.
- `npm run check` passes (format, evidence, lint, typecheck, test, knip, secrets). `npm run audit` shows no new
  findings.
- Startup is measured on the reference machine with the probe above and reported in the PR description:
  - **Flag off:** no measurable change to router extension load (within run-to-run noise).
  - **Flag on:** the one-time lazy import adds no more than **50 ms** at p50 to the first classifier call. The subpath
    measurement above (~43 ms) fits under this; a barrel import (~153 ms) does not.

**Shadow period (flag on for personal sessions, one to two weeks):**

- Compare `timedOut`, `cancelled`, and `deadlineStage` outcomes from the router's JSONL telemetry against the flag-off
  baseline over the same kind of work. The telemetry store already records these fields.
- **Proposed go criteria:** at least 50 classifier invocations with the flag on; no increase in
  `errorCategory: "deadline"` or in turns that never complete; no unexplained cancellations. The first invocation of
  each session pays the lazy-import cost, so compare first-call and later-call latency separately.

**Go / no-go:** if the go criteria hold, Phase 1 may be scoped. If not, set the flag permanently off, remove the
dependency, and keep this record with the findings. Either outcome is a valid result of Phase 0.

## Rollback

- **Immediate:** turn the flag off. The existing implementation runs again, and Effect is no longer loaded. No migration
  is involved.
- **Full:** revert the Phase 0 commit(s) and remove `effect` from `extensions/router/package.json`. The lockfile reverts
  with it. The timer seam from scope item 2 can stay; it has no dependency.

## Phase 1 and 2 (conditional, not committed)

- **Phase 1 — subagent RPC lifetimes.** Model pending requests and child-process termination with scoped finalizers, so
  every child is reaped on every path. Go/no-go gates:
  - Phase 0 passed its go criteria, including the flag-on startup gate.
  - A cross-platform test plan that covers Windows `taskkill` and process-tree kills.
  - A decision on whether `mock-rpc-child.mjs` is sufficient or a real child fixture is needed.
  - The subagent extension can load Effect lazily the same way, or the measured eager-load cost is accepted explicitly.
- **Phase 2 — services layer.** Reconsider `Layer`/`Context` only if Phase 1 shows the injectable-seam pattern breaking
  down across more than one extension. Otherwise keep the manual seams.

## Explicitly out of scope

- Lease, fallback, and routing policy (`router/core/*`). Pure policy stays, and lease state follows #100.
- The vendored `extensions/otel` fork. It has its own manifest and is excluded from typechecking.
- The `pi-overlay` skill-patch pipeline and `scripts/`.
- Changing the Pi extension entry points. They stay Promise-based.

## Open questions

1. **Effect v4 testing surface.** Partly answered: `effect@4.0.2` exports `TestClock` from `effect/testing`. Whether it
   can drive this function's timers without wiring the whole runtime is still for the spike. If not, use the timer seam
   from scope item 2 or `node:test` `mock.timers`.
2. **Startup cost.** Answered: see [Startup and size measurement](#startup-and-size-measurement). The 25 ms proposal is
   not reachable with Effect loaded, so the gate is now "flag off loads nothing; flag on ≤ 50 ms at p50". Rerun the
   probe on the reference machine before the spike PR.
3. **Issue ownership.** Answered: router work is tracked in `nigel-upstart/pi-buildout` (for example #81, #100, #108,
   and `specs/routing-layer/future-work.md` links there). Only the otel ownership decision
   (`specs/otel-ownership-decision.md`) uses `zew1me/pi-buildout`. The Phase 0 spike issue belongs in
   `nigel-upstart/pi-buildout`.
4. **Traffic Control pairing.** `sardine-run-stack` requires a GitHub issue for each AI-driven session. File the Phase 0
   spike issue in `nigel-upstart/pi-buildout` when the spike is scheduled, and pair it then.

## Sources

- Effect docs (conceptual only, no code copied): <https://effect.website/docs/v4/onboarding>,
  <https://effect.website/docs/v4/getting-started/the-effect-type>,
  <https://effect.website/docs/v3/getting-started/why-effect>
- Hacker News discussion on Effect 4.0: <https://news.ycombinator.com/item?id=49925812>
- TypeScriptWorld, Effect vs fp-ts:
  <https://typescriptworld.com/effect-vs-fp-ts-error-tracking-and-the-two-learning-curves>
- `effect@4.0.2` package metadata and export map, inspected locally for the startup measurement and the `TestClock`
  check. No package code was copied.
- Recorded in [`ATTRIBUTION.md`](../ATTRIBUTION.md).
