# Routing layer — evaluation harness

Companion to [`SPEC.md`](SPEC.md) (the functional spec — see its own "Evaluation" section for the
metrics this harness reports) and [`decisions.md`](decisions.md) (architecture). Not implemented yet.

## Decision: TS-native harness, real provider calls via Bifrost — no mocks

There is no TypeScript eval framework in use anywhere across the user's reference repos, and no
single company-mandated eval tool even in Python — Upstart's own eval-platform choice is explicitly
still open (`ai-acceleration#136` weighs Arize Phoenix vs LangSmith vs Logfire). The two most
institutionalized internal options, Arize/Phoenix (chosen over promptfoo/DeepEval per SRE's
ADR-0032) and pydantic-evals + Logfire, are both Python-only, and every existing TS repo that touches
an LLM **mocks the provider in tests** rather than calling it for real.

Given that, and that the router itself is TypeScript, in-process, and the workload is
LLM-I/O-bound (see `decisions.md`), the harness for this component is a small **TS-native suite that
makes real calls** rather than reaching into an external Python eval platform:

- One language, living next to the code it evaluates, runnable the same way as the router's own
  unit tests (`node --test`).
- **Real calls, no mocks** — through Bifrost, the same sanctioned gateway the router itself uses
  (see `decisions.md`'s Provider access section), so the eval measures the same request path the
  router runs in production, not a stand-in.
- Adds no new institutional platform dependency; if a future company-wide eval platform decision
  lands, this harness's real-call, no-mock discipline transfers directly — only the runner/scoring
  glue would move, not the philosophy.

This is deliberately narrower than Arize/Phoenix or pydantic-evals: no experiment-tracking UI, no
hosted dataset store, no trace-based regression dashboard. If the router's evaluation needs grow
past what a golden-corpus `node --test` suite can hold, revisit adopting one of Upstart's Python
eval platforms rather than growing a bespoke one here — but that is out of scope until there's
evidence this harness can't keep up.

## What gets evaluated

Two separate things, per `SPEC.md`'s "Evaluation" section — always scored **as a paired
(model, prompt profile) treatment**, never one without the other:

### 1. Classifier accuracy

Real calls to the configured primary (and, for ambiguous/high-risk fixtures, secondary)
classifier — through Bifrost, using whichever entrypoint `decisions.md`'s Open Items resolve to
(`completeSimple` or the bundled-SDK fallback) — scored against a golden corpus of
(prompt, context synopsis) fixtures with hand-authored expected feature objects.

Metrics (mirroring `SPEC.md`'s classifier-metrics list):
- exact-match and per-axis accuracy across the required classification axes (intent, action mode,
  archetype, planning horizon, risk, review intent, …);
- confidence calibration (does stated confidence track actual correctness);
- false and missed review-intent rate;
- hard-policy violation rate (a fixture whose expected output the classifier must never contradict —
  e.g. a review request classified as anything but `review_intent: true`);
- primary/secondary disagreement rate, for fixtures that force escalation;
- latency and token cost per classification call.

### 2. Prompt-profile quality

For a small set of representative tasks (one per archetype in the bootstrap priors table), run the
compiled prompt through the archetype's bootstrap model via Bifrost, then score the response with an
**LLM-as-judge** (also a real Bifrost call, from a model different than the one being judged) against
the profile's own stated goals from `SPEC.md`'s model-specific-profile expectations:

- instruction adherence (did the response follow the compiled contract, not just the raw user ask);
- output-schema validity, where the archetype specifies structured/rigid output;
- unnecessary-clarification / premature-stop signals in the raw transcript;
- a judge-assigned pass/fail plus short rationale, not just a score, so failures are diagnosable.

## Golden corpus

`extensions/router/eval/corpus/*.json` — one fixture per file:

```json
{
  "id": "median-repo-impl-001",
  "prompt": "Add input validation to the /users endpoint",
  "contextSynopsis": { "...": "deterministically-shaped synopsis, matching SPEC.md's schema" },
  "expected": {
    "intent": "implement",
    "archetype": "median_repository_implementation",
    "risk": "medium",
    "review_intent": false
  }
}
```

Corpus composition: at least one fixture per archetype row in `SPEC.md`'s bootstrap priors table,
plus fixtures specifically targeting each hard boundary (new window, post-compaction, post-push,
subagent) and each confidence-escalation path (low confidence, high risk, disagreement). Sourced from
this repo's own spec and from real (anonymized) task descriptions — never copied from the external
reference document's examples, consistent with `SPEC.md`'s "spec is the authority, not the
reference" stance.

## Harness shape

```
extensions/router/eval/
  corpus/*.json          # golden fixtures (see above)
  run.mjs                # node:test entry point; drives real Bifrost calls
  score.ts               # exact-match / per-axis accuracy scoring for classifier fixtures
  judge.ts               # LLM-as-judge scoring for prompt-profile fixtures
  report.mjs             # aggregates a run into the SPEC.md metrics list; prints/exports a summary
```

- Runs via `node --test extensions/router/eval/*.test.mjs`, alongside the router's own unit tests,
  but is **gated on `BIFROST_VIRTUAL_KEY` being present in the environment** — skip cleanly (not
  fail) when absent, so ordinary `npm test`/CI runs that don't have a provisioned key still pass.
  Provision a key via the `/bifrost-virtual-key` skill for local/CI runs that do want real coverage.
- Never mocks the provider. If Bifrost is unreachable or the key is invalid, the run fails loudly
  rather than silently falling back to a stub.
- Reports p50/p75/p90-style aggregates per archetype, matching `SPEC.md`'s "compute distributions,
  not averages" telemetry guidance, so a regression in one archetype doesn't hide in an overall
  average.

## When this runs

- **Locally**, on demand, while iterating on `classifier.ts` or a specific prompt profile.
- **In CI**, on PRs touching `extensions/router/**`, using a CI-scoped Bifrost virtual key
  (one key per use case per environment, per Upstart's ADR-005) — never the same key as production
  routing traffic.
- **Before shadow mode ends** (`SPEC.md`'s implementation-sequence step 7 → 8 gate): a full corpus
  run with no hard-policy violations and no regression against the last accepted baseline is a
  precondition for letting the router influence live routing.

## Non-goals

- No experiment-tracking dashboard or hosted dataset store (see Decision above) — reconsider only if
  this harness's scope outgrows a golden-corpus `node --test` suite.
- No synthetic-only corpus — fixtures should be traceable to a real archetype or boundary case in
  `SPEC.md`, not invented to pad coverage numbers.
- No mocking, ever, for this harness specifically — that is the entire point of building it
  TS-native instead of reusing an existing mocked test pattern from elsewhere in the org.
