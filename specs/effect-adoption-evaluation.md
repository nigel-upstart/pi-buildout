# Effect v4 adoption: evaluation and Phase 0

Status: **proposed — bounded pilot recommended, broad adoption rejected**. Analysed 2026-10-08 against `origin/main` at
`cbeb426ec`. Tracked by Traffic Control session `9708a77d` in `sardine-run-stack`. Source research: the vault note
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
   propagation, and timer cleanup must be right, it already has a 10-test oracle, and it already has an injectable
   deadline seam. It is also on the live turn path, so Phase 0 is built to be switched off, not assumed safe.

## Evidence from the code

Measured on `origin/main` (non-test TypeScript only; counts are approximate).

| Area                                                      | What is hand-rolled                                                                                                                                                                                                                          | Effect fit                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `router/telemetry.ts` `runClassifierInvocation` (171–290) | Overall and per-stage `setTimeout`s, `AbortController` abort on overrun, a `Settled` race between result, error, and deadline, and timer clearing in every branch. A `deadline` adapter (`set`/`clear`, ~574) is already injected for tests. | **High.** This is the timeout/abort/race structure Effect expresses directly (`Effect.timeout`, `Effect.race`, interruption). |
| `router/index.ts` grace timers (~1105–1140)               | Grace-period `setTimeout` with a resolve-or-timeout race.                                                                                                                                                                                    | Medium. Would move with Phase 0 only if it shares the same helper.                                                            |
| `router/pi-classifier.ts` endpoint fallthrough (~110–125) | Any thrown error falls through to the next endpoint; cancellation is the single exception. This is an error-classification rule written as an `if`.                                                                                          | Medium. Typed errors make the cancellation exception explicit. Small code, so low payoff alone.                               |
| `subagents/rpc.ts` termination (~380–740)                 | Pending-request timers, a SIGTERM → poll → SIGKILL → terminal-cleanup state machine using `setInterval`, `setTimeout`, and Windows `taskkill` counters, plus a process-tree monitor.                                                         | **High in principle, highest risk in practice** (process trees, cross-platform). Phase 1 at the earliest.                     |
| `router/core/fallback.ts`, `routing.ts`, lease machine    | Pure policy functions, already modelled with `xstate`, and covered by property tests (`fast-check`).                                                                                                                                         | **Low.** Effect would add a second state vocabulary next to `xstate`. Not adopted.                                            |
| `router/telemetry.ts` JSONL store                         | Best-effort append, no concurrency or cancellation semantics that matter.                                                                                                                                                                    | Low. Not adopted.                                                                                                             |

Other facts that bear on the decision:

- **Retries are not a general layer here.** The 24 `retry|backoff` hits are mostly routing-economics terms (`retryCost`,
  `probabilityRetry`), not retry loops. The only retry-like behaviour is the classifier fallthrough above. Effect's
  `Schedule` would replace very little today.
- **DI already exists in manual form.** The injectable `deadline` adapter and per-module seams are a small, hand-written
  version of what `Context`/`Layer` provide. That lowers the value of a repo-wide DI migration.
- **Scale.** The router is ~14.7k non-test lines of TypeScript and the subagent extension ~1.9k. Both are large enough
  for timer and cancellation bugs to matter, and not so large that a single pilot module is hard to review.
- **Dependency precedent.** `extensions/router/package.json` already ships runtime dependencies (`xstate`,
  `shell-quote`, `shlex`) that the installer materialises next to the extension. Adding `effect` there follows an
  existing path rather than inventing one. The `otel` fork carries its own manifest for the same reason.
- **Toolchain.** Root `typescript` is `^5.9.3`, which meets Effect v4's stated floor.

## Why it is worth a pilot

- **The failure modes are the kind Effect makes structural.** The deadline runner has to abort the in-flight request,
  discard a result that arrives after the deadline, and clear every timer on every path. Those invariants are currently
  enforced by careful code and tests. Effect's interruption and finalizers make them part of the program's shape.
- **Tests can get stronger.** The same invariants can be asserted directly: the abort signal reached the request, a late
  result was ignored, and no timer outlived the invocation.
- **Adoption can be incremental.** One module, one exported function, and an `Effect.tryPromise` boundary around the
  existing Promise-based `invoke`. Nothing above the function changes.
- **The cost of finding out is bounded.** The change is one module plus one manifest entry, and it is reversible with a
  flag and a revert.

## Why it is not worth broad adoption now

- **The Pi extension API is Promise and callback based.** Every hook (`pi.on`, tool execution, RPC) needs a boundary.
  The research note's warning applies directly: typed-error guarantees weaken when a codebase mixes Effect and plain
  Promise code inconsistently.
- **The routing core is already well-modelled.** Pure policy, `xstate`, and property tests cover it. Effect would
  duplicate that rather than improve it.
- **Shipping a runtime library into every user's Pi startup is a real cost** that we have not measured yet (see Phase 0
  gates).
- **Effect v4 is recent.** `4.0.0` is only a few releases old in the registry. We have no measured stability history for
  the v4 API, so the pilot must pin an exact version.
- **The benefit claims are unverified here.** The "built for the AI era" framing in the vendor docs is marketing. We
  have no measurement of agent productivity or error reduction in this repo, and this evaluation does not rely on one.
- **Learning cost.** The research note estimates a few focused days. On a repo with one primary maintainer, that cost
  should buy a concrete result before it is spread.

## Candidate comparison for Phase 0

| Candidate                                             | Effect fit | Blast radius                                                                                   | Oracle                                                | Seam                        | Decision                                      |
| ----------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- | --------------------------------------------- |
| Classifier stage deadline (`runClassifierInvocation`) | High       | Medium. On the turn path; a timeout keeps the current model, a bug could hang or cancel early. | `telemetry.test.mjs` (10 tests), `index.test.mjs` (4) | Injected `deadline` adapter | **Phase 0**                                   |
| Classifier endpoint fallthrough (`pi-classifier.ts`)  | Medium     | Medium. Changes which endpoint answers.                                                        | `pi-classifier.test.mjs`                              | Partial                     | Phase 0 runner-up; revisit after Phase 0 gate |
| Subagent RPC termination (`subagents/rpc.ts`)         | High       | High. Process trees, Windows `taskkill`, user-visible kill semantics.                          | `rpc.test.mjs`, `mock-rpc-child.mjs`                  | Partial                     | Phase 1, conditional                          |
| Lease, fallback, routing policy                       | Low        | High. Core decisions.                                                                          | Property tests                                        | Pure functions              | Not adopted                                   |
| Telemetry JSONL persistence                           | Low        | Low                                                                                            | `telemetry.test.mjs`                                  | n/a                         | Not adopted                                   |

**Why the classifier deadline runner is Phase 0, and why not the others:**

- It is the **only candidate where Effect's core features map one-to-one onto the existing code**: timeout, abort, race,
  and cleanup. The fallthrough rule needs typed errors but little else, so it would not exercise the model.
- Its blast radius is **real but containable**. A flag can keep the current implementation as the default until the gate
  passes. The subagent termination code cannot be contained that way: it cleans up child processes, and a faulty version
  can leave orphaned processes on Windows or macOS.
- It has the **strongest existing oracle**: ten tests that already pin timer and abort behaviour, against an injectable
  seam, so parity is checkable without a live model.
- Doing it first also **proves the packaging path** (a new runtime dependency in `extensions/router/package.json`,
  materialised by the installer, audited by `npm run audit`). That is the most likely source of surprise, and it is
  cheap to learn on a small change.
- The subagent termination code is the **better long-term target**, but it should only be attempted once Phase 0 has
  shown the packaging, test, and startup costs are acceptable.

## Phase 0 scope

Scope is **one function** plus the packaging it needs.

1. Add `effect` pinned to an exact version (`4.0.2` at analysis time) to `extensions/router/package.json`. Do not add it
   to the root manifest. Regenerate the lockfile through the extension's own install path.
2. Implement an Effect-backed deadline and abort path for `runClassifierInvocation` in a sibling module. It must keep
   the same exported signature, the same injected `deadline` seam, and the same `summary` shape.
3. Select the implementation with a single setting, default **off** (the existing `Promise` implementation remains the
   default). Use either an environment variable or the existing router config, not both.
4. Bridge the existing `AbortSignal` into Effect at the boundary (`Effect.tryPromise` with the signal) so network
   cancellation still reaches the transport.

### Acceptance gates

**Before merge:**

- All ten `runClassifierInvocation` tests in `extensions/router/telemetry.test.mjs` pass **unchanged** with the flag
  off, and with the flag on.
- New tests assert, for the Effect path: an overrunning stage aborts the signal passed to `invoke`; a result that
  arrives after the deadline is discarded; the injected `deadline.clear` is called on every completion path, including
  cancellation.
- `npm run check` passes (format, evidence, lint, typecheck, test, knip, secrets). `npm run audit` shows no new
  findings.
- Module-load time of the router extension is measured before and after, in the PR description. **Proposed threshold: no
  more than 25 ms added at p50 on the reference machine; agree the number before the PR is opened.**

**Shadow period (flag on for personal sessions, one to two weeks):**

- Compare `timedOut`, `cancelled`, and `deadlineStage` outcomes from the router's JSONL telemetry against the flag-off
  baseline over the same kind of work. The telemetry store already records these fields.
- **Proposed go criteria:** at least 50 classifier invocations with the flag on; no increase in
  `errorCategory: "deadline"` or in turns that never complete; no unexplained cancellations.

**Go / no-go:** if the go criteria hold, Phase 1 may be scoped. If not, set the flag permanently off, remove the
dependency, and keep this record with the findings. Either outcome is a valid result of Phase 0.

## Rollback

- **Immediate:** turn the flag off. The existing implementation runs again. No migration is involved.
- **Full:** revert the Phase 0 commit(s) and remove `effect` from `extensions/router/package.json`. The lockfile reverts
  with it.

## Phase 1 and 2 (conditional, not committed)

- **Phase 1 — subagent RPC lifetimes.** Model pending requests and child-process termination with scoped finalizers, so
  every child is reaped on every path. Requires: the Phase 0 gate passed; a cross-platform test plan that covers Windows
  `taskkill` and process-tree kills; and a decision on whether `mock-rpc-child.mjs` is sufficient or a real child
  fixture is needed.
- **Phase 2 — services layer.** Reconsider `Layer`/`Context` only if Phase 1 shows the injectable-seam pattern breaking
  down across more than one extension. Otherwise keep the manual seams.

## Explicitly out of scope

- Lease, fallback, and routing policy (`router/core/*`). `xstate` and pure policy stay.
- The vendored `extensions/otel` fork. It has its own manifest and is excluded from typechecking.
- The `pi-overlay` skill-patch pipeline and `scripts/`.
- Changing the Pi extension entry points. They stay Promise-based.

## Open questions

1. **Effect v4 testing surface.** Does `effect@4` expose a test-clock or equivalent deterministic timer utility, and is
   it usable without wiring the whole runtime? Verify in the spike. If not, port the timer tests to the injected
   `deadline` adapter instead.
2. **Startup cost.** Is the 25 ms proposal reasonable on the reference machine? Measure before agreeing.
3. **Issue ownership.** `origin` is `nigel-upstart/pi-buildout`, but `specs/otel-ownership-decision.md` links issues in
   `zew1me/pi-buildout`. Confirm which tracker this work should be filed in. No GitHub issue has been created yet.
4. **Traffic Control pairing.** `sardine-run-stack` requires a GitHub issue for each AI-driven session. The pairing is
   pending the answer to question 3.

## Sources

- Effect docs (conceptual only, no code copied): <https://effect.website/docs/v4/onboarding>,
  <https://effect.website/docs/v4/getting-started/the-effect-type>,
  <https://effect.website/docs/v3/getting-started/why-effect>
- Hacker News discussion on Effect 4.0: <https://news.ycombinator.com/item?id=49925812>
- TypeScriptWorld, Effect vs fp-ts:
  <https://typescriptworld.com/effect-vs-fp-ts-error-tracking-and-the-two-learning-curves>
- Recorded in [`ATTRIBUTION.md`](../ATTRIBUTION.md).
