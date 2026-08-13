# Routing layer — tracked future work

These items are intentionally deferred from the MVP. They are documented here so the current implementation stays small
without turning known limitations into accidental policy.

## FW1 — Endpoint circuit breakers and active health recovery

**Status:** deferred; design and implement before routing is enabled for unattended production workloads.

The current fallback state machine reacts to an availability failure within one task lease and then moves to the next
authorized exact choice. It does not retain endpoint health across leases.

Add a per-endpoint circuit breaker that:

- opens after a bounded combination of timeouts, transport failures, rate limits, and poor-quality outcomes;
- fails fast instead of waiting repeatedly on an endpoint already believed unhealthy;
- uses bounded, low-cost background probes to move from open to half-open and then healthy;
- keeps health state separate from task quality telemetry and records every state transition;
- prevents probe traffic from carrying repository or user content;
- preserves the existing exact-ID, provider-diversity, and bounded-fallback policy;
- has deterministic clock/probe tests, restart behavior, and operator controls.

Classifier timeout ownership at the router boundary is now specified and implemented: one 11-second wall-clock deadline
covers the complete fresh-task or continuity request; its `AbortSignal` reaches pi-ai; `AbortError`/`TimeoutError` stops
schema retries, endpoint fallback, and secondary escalation; and failure retains the current lease/model rather than
moving on. This is not part of the deferred circuit breaker.

The remaining timeout work is below that boundary. Before implementing active endpoint health recovery, inventory and
normalize provider-adapter connect/read/retry timeouts, verify which transports actually terminate remote work after
abort, and define how a transport timeout contributes to circuit state without double-counting the router deadline. This
lower-level ownership and remote-cancellation observability is still provider-specific; the router must not infer a
healthy or fully cancelled remote endpoint merely because its own deadline returned.

## FW2 — Workflow-specific horizon semantics

**Status:** deferred; revisit when the corpus contains enough non-coding planning and operations examples.

The classifier currently uses one bounded `horizon` enum. Its PR-oriented middle values are natural for software
implementation but less clear for research, advisory, incident, and non-coding tool workflows. Do not add a second axis
until it improves measured routing accuracy.

Evaluate either:

1. documenting a workflow-to-horizon interpretation table while retaining one schema field; or
2. replacing the field with a discriminated workflow-specific horizon schema.

Any change must preserve strict schema validation, update all classifier prompts and corpus fixtures, include a
migration for persisted leases, and demonstrate better archetype accuracy without increasing hard-policy violations.

## FW3 — Observed GPT-5.6 cache-read ratios across endpoints

**Status:** deferred; collect comparable endpoint telemetry before drawing a behavioural conclusion.

Determine whether Amazon Bedrock and OpenAI direct endpoints yield materially different observed `cacheRead` ratios for
GPT-5.6, despite both providers documenting a 30-minute minimum TTL for that model family. Compare like-for-like
prompts, logical models, request timing, token accounting, and cache-write observations; report sample counts and
uncertainty so endpoint traffic mix is not mistaken for provider behaviour.

A measured divergence cannot change Bedrock-versus-first-party endpoint ordering. The confirmed Bedrock contract weight
is a uniform scalar over every billed token class, so it remains order-preserving for the exact rate-parity pairs
already identified. The pr3 invariant would not detect this behavioural divergence: it reads registry rates and
cache-rate classifications, not observed `cacheRead` outcomes. Use the PR7 per-endpoint `cacheRead` and `cacheWrite`
telemetry to answer the operational question without turning it into a selection rule.

## FW4 — Cache-class eligibility, blocked on a measured cache-read share

**Status:** deferred; the mechanism is deliberately absent rather than present and disabled.

`core/endpoint-cost.ts` can now price an endpoint under the operator's observed token mix (`referenceMixEndpointCost`)
and express the result as a break-even token multiplier (`breakEvenTokenMultiplier`). Both are diagnostics. Neither
orders routes, and no eligibility guard reads them.

The obvious next step is a guard that refuses a `caching_unpriced` endpoint on cache-heavy work, because such an
endpoint pays its full input rate on every reused token while a cache-priced peer does not. The measured erosion is
large: against Bedrock Claude Haiku 4.5, MiniMax M2.5's break-even falls from 3.5x to 2.4x as the cache-read share of
input-side tokens rises from 12% to 70%, and GLM-5 crosses below 1.0, meaning it becomes more expensive per token than
the rung it was supposed to undercut.

That guard is not implemented, for one reason: the cache-read share it would key on is **assumed, not measured**. The
10.61% figure is an estate-wide CloudZero observation across all Bedrock traffic, and this router deliberately holds
leases to preserve K/V cache (`hasSignificantReusableCache` in `core/lease.ts`), so its own share should be materially
higher — but nothing measures it. Shipping a guard whose threshold rests on a modelled number would repeat the failure
mode this repository criticises elsewhere, and shipping it disabled behind a knob would add a tuning surface that no
observation can yet set.

Today the guard would affect exactly two endpoints, the `amazon-bedrock/openai.gpt-oss-120b` spellings, which are the
cost-floor availability tail of the bounded read-only ladders. Excluding the cheapest tail on an assumed number is a
poor trade.

Prerequisites, in order:

1. Per-endpoint observed `cacheRead` and `cacheWrite` token telemetry, stratified by archetype — the same measurement
   FW3 requires. Report distribution and sample counts, not a point estimate.
2. A decision on whether the share is a property of the archetype, of the lease's reusable-cache signal, or of both.
3. Only then a guard, with its threshold derived from the observed distribution and its exclusion recorded with the
   classification and threshold that produced it.
