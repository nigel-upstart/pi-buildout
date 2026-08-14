# Router real-provider evaluation — 2026-08-13 (scoped-model admission, `router-policy-v7`)

First real-provider run since the scoped-model work. It was made possible by an operator-supplied Bifrost virtual key;
earlier phases had no key available, so every claim about live provider behaviour in that work was necessarily
deterministic or documentary.

Two results matter, and one of them contradicts an assumption recorded in [`decisions.md`](decisions.md).

## Bedrock tool-call fidelity for the admitted scoped model

This closes the unverified assumption flagged during the admission: `toolCapable` in
[`pi-state.ts`](../../extensions/router/pi-state.ts) is inferred from a substring heuristic, not from a capability flag
or a measurement, and nothing had established that a Bedrock scoped endpoint honours a forced tool call at all.

Probed through the Bifrost gateway against `bedrock/minimax.minimax-m2.5`, using the router's own primitives —
`requireToolCall`, the classifier tool schema, and `validateToolArguments` — with `bedrock/openai.gpt-oss-120b` and
`bedrock/openai.gpt-5.6-luna` as controls on the same gateway and the same Bedrock surface.

| Endpoint                       | Forced tool call | Schema-valid, 20-field classifier schema |
| ------------------------------ | ---------------- | ---------------------------------------- |
| `bedrock/minimax.minimax-m2.5` | 3/3              | 0/3                                      |
| `bedrock/openai.gpt-oss-120b`  | 3/3              | 0/3                                      |
| `bedrock/openai.gpt-5.6-luna`  | 3/3              | 3/3                                      |

**The mechanism works.** All three endpoints returned a tool call with the requested name on every attempt, so
`tool_choice` is honoured through the gateway to Bedrock and the substring-derived `toolCapable` is not wrong about the
mechanism for these endpoints.

**Schema fidelity is a separate property and is not established for the cheap rungs.** MiniMax M2.5 produced the correct
tool call every time and schema-valid arguments none of the time on the 20-field `TaskFeaturesSchema`, failing on
missing required properties (`interactivity`, `reviewIntent`) and out-of-enum values. `gpt-oss-120b`, which was already
an admitted rung before this work, failed the same schema on a different axis (`evidence` below its minimum item count).
Only Luna was reliable.

Scope of that finding, stated precisely:

- It does **not** affect the classifier path. Neither MiniMax nor `gpt-oss-120b` is a classifier tier; those are Luna
  and Haiku primary, Sonnet 5 and Terra secondary.
- It does **not** bear on `fast_classification` as a routed archetype, which returns a classification for the user's
  task rather than a strict schema.
- It **does** bear on `exact_extraction`, whose declared purpose is to emit exactly a supplied schema. MiniMax produced
  valid output 3/3 on a deliberately small three-field schema and 0/3 on the 20-field one, so schema size or strictness
  plainly matters, and nothing here locates the boundary. The admission to `exact_extraction` should be treated as
  unsupported for large or strict schemas until a schema-fidelity measurement exists.

One measurement in that probe is discarded: a small-schema case scored Luna and `gpt-oss-120b` at 0/3 because the
fixture used lower-case literals (`"typescript"`) while the prompt said "TypeScript", so the models returned the
capitalised form and failed on case. That is a defect in the probe, not an observation about the models, and no
conclusion is drawn from it.

## Classifier accuracy against its own gate, and a systematic under-read

The checked-in eval asserts `archetypeAccuracy >= 0.8`. Across the golden corpus with profile treatments bounded to one:

| Run | `archetypeAccuracy` | `calibration` | Gate |
| --- | ------------------- | ------------- | ---- |
| 1   | 0.889               | 0.497         | pass |
| 2   | 0.778               | 0.392         | fail |
| 3   | 0.778               | 0.392         | fail |

`missedReviewRate`, `falseReviewRate` and `disagreementRate` were 0 in every run. The archetype gate is therefore
borderline rather than comfortably met, and calibration is both low and noisy run to run.

The important result is the direction of the `actionMode` errors, not the headline accuracy. Over 18 fixtures:

| Direction                                                | Count |
| -------------------------------------------------------- | ----- |
| Under-read: derived consequence lower than the fixture's | **3** |
| Over-read: derived consequence higher than the fixture's | 0     |
| Same-severity relabel, no consequence change             | 2     |

The three under-reads were `external_side_effect` received as `information_only`, `reversible_mutation` received as
`local_read`, and `reversible_mutation` received as `information_only`. A separate `risk` mismatch reported `critical`
received as `medium`, which under-reads the other input that raises consequence to irreversible.

There were **no** over-reads. The classifier is not erring conservatively; on this corpus it errs toward under-stating
consequence.

Two caveats bound the strength of this, both of which make it more concerning rather than less. The sample is 18
fixtures, so the rate itself is imprecise. And the eval's default classifier is `gpt-5.6-sol`, which is a stronger model
than the production classifier tiers, so production Luna and Haiku would not be expected to do better.

## Consequence for the recorded `luna@medium` decision

Decision 4 of the scoped-model admission section in [`decisions.md`](decisions.md) chose `gpt-5.6-luna@medium` as the
`fast_classification` primary, accepting a stated residual risk: a classifier that mis-reads a mutating task as
read-only lets `luna@medium` run on mutating work at its measured 23.5% regression-break rate, where `luna@high`
measures 9.1%. That decision recorded its own reversal condition:

> The exposure is therefore bounded by classifier action-mode accuracy, which `eval.md` already tracks as a first-class
> metric. If that accuracy proves worse than the 9.1%-to-23.5% gap this trades on, the correct response is to promote
> the primary to `luna@high` rather than to add an exception.

That condition is met. Three action-mode under-reads in 18 fixtures, with zero over-reads and a `critical`-risk
under-read alongside, is not a bounded exposure against a 14-point breakage gap. By the decision's own criterion the
primary should be promoted to `luna@high`.

The same measurement bears on the read-only confinement that governs the admitted scoped model. That guard refuses a
`singleAttemptEvidence` candidate outside read-only consequence, but it reads the same derived consequence, so an
action-mode under-read admits MiniMax M2.5 to mutating work exactly as it admits `luna@medium`. The guard is correct and
remains necessary — the earlier verification that disabling it lets the model route for `reversible_mutation` still
stands — but its protection is conditional on an input this run shows to be unreliable in the unsafe direction.

Neither change is applied in this record. The `luna@medium` choice was an explicit operator decision and its reversal is
one too; this document supplies the measurement that decision asked for.

## Reproducing

```sh
export BIFROST_BASE_URL=...    # gateway base URL
export BIFROST_VIRTUAL_KEY=... # never commit this; .env is gitignored
ROUTER_EVAL_PROFILE_LIMIT=1 npm run test:eval:real
```

`ROUTER_EVAL_LIMIT=1 ROUTER_EVAL_PROFILE_LIMIT=1` runs a cheap single-fixture canary first, which is the recommended way
to validate connectivity before spending on a full run. The tool-call probe above is not checked in as a test: it calls
real providers and costs money, so it belongs with the deferred opt-in probe work in [`future-work.md`](future-work.md)
rather than in the default suite.
