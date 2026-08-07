# Routing layer — architecture decisions

Companion to [`SPEC.md`](SPEC.md) (the functional spec), [`eval.md`](eval.md) (the evaluation harness), and
[`source-basis.md`](source-basis.md) (design provenance and public references). This document records _how_ it will be
built and why — language, framework, tooling — plus the implementation-time findings that resolve the original open
items. The extension is implemented and remains in its intended shadow-first rollout.

## Decision: TypeScript, in-process, as a pi extension

The workload is **LLM-I/O-bound**, not compute-bound: the deterministic core (eligibility filter, ranking, lease state
machine, prompt compiler) runs once per task boundary over kilobytes of data — microseconds to low milliseconds of work
— while every classifier call and model turn is a multi-second network round trip. A faster core language buys
effectively zero wall-clock; there is no hot loop to justify one.

What _is_ recurring cost is the **per-turn integration boundary**: the router is consulted on every user turn. Running
the discarded historical Python prototype out-of-process as a sidecar would mean IPC plus full harness-state
serialization (session, tokens, tool inventory, builder identity, cache stats) on every turn. Running in-process in pi's
own runtime avoids that entirely.

pi's `ExtensionAPI` (`@earendil-works/pi-coding-agent`, verified against v0.80.7's `dist/core/extensions/types.d.ts`)
already exposes every hook this spec's pipeline needs:

| Spec requirement                                         | pi `ExtensionAPI` primitive                               |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Only a user-input turn triggers boundary evaluation      | `on("input", …)`                                          |
| Hard boundaries: new window / post-compaction / subagent | `session_start`, `session_compact`, `session_before_fork` |
| Estimated token counts & context-window feasibility      | `ctx.getContextUsage()` plus provider-reported usage      |
| Model eligibility, context window, cost, API keys        | `ctx.modelRegistry` / `ModelRegistry`                     |
| Builder identity (for independent review routing)        | `ctx.model`                                               |
| Apply the lease (model + effort)                         | `setModel(model)`, `setThinkingLevel(level)`              |
| Expose only phase-valid lifecycle validators             | `getActiveTools()` / `setActiveTools()`                   |
| Inject the compiled model-specific prompt profile        | `before_agent_start` → `systemPrompt` result              |
| Resolve exact policy IDs against live endpoints          | `ctx.modelRegistry.getAll()` / `.getAvailable()`          |
| Persist/reevaluate the lease across turns                | `appendEntry` + re-check on `input`                       |

The existing extensions in this repo (`extensions/{clear,effort,markdown-backlinks}`, each `index.ts` + `helpers.ts` +
`index.test.ts`) already demonstrate the shape this layer should take.

**The prose functional spec (`SPEC.md`) is the implementation authority — not the historical Python prototype described
in `source-basis.md`.** That prototype was untested and untrialed; its output shapes, schemas, and behavior were not
imported. Tests are authored directly from `SPEC.md`'s invariants and the checked-in TypeScript contracts.

## Why not an agent framework

Not LangChain, CrewAI, LangGraph, or the Anthropic/OpenAI Agents SDKs. What we're building is a **router** — a
classifier plus a deterministic decision engine plus a prompt compiler — not an agent: there is no agentic loop, tool
orchestration, or multi-agent coordination to own, because pi already is the agent and owns the loop. Dropping an agent
framework in would fight the in-process integration described above and add a heavy abstraction around what is, on the
LLM side, a single low-temperature structured-output classification call. The repository therefore uses no agent
framework.

## Dependency set

pi's bundled packages already cover nearly the entire runtime surface. Reuse them; do not add equivalents:

| Need                         | Reuse (already available)                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema/validation            | **TypeBox** through its canonical `typebox` / `typebox/value` exports. Not Zod — TypeBox is a first-class pi dependency and matches pi's own `ToolDefinition` model.                                         |
| Structured classifier output | forced **tool call** with TypeBox parameters, validated via pi-ai's `validateToolCall`/`validateToolArguments` (+ `parseJsonWithRepair` for recovery). There is no `response_format`-style enforcement path. |
| One-shot LLM call            | pi-ai's public `complete()` compatibility export, with registry-resolved auth (verified live).                                                                                                               |
| Provider access              | **[Bifrost](https://github.com/maximhq/bifrost)** where configured — see the Provider access section below.                                                                                                  |
| Token/context sizing         | `ctx.getContextUsage()` + pi-ai's `estimateContextTokens`/`calculateCost` helpers. No tiktoken — pi has no real tokenizer, and estimation is the norm here.                                                  |
| Eligibility/ranking inputs   | `ctx.modelRegistry.getAvailable()`/`.find()`, `Model.{cost,contextWindow,maxTokens,reasoning}`, pi-ai's `calculateCost()`.                                                                                   |
| Lease/state persistence      | `pi.appendEntry()` (per-session custom entries) + `getAgentDir()`.                                                                                                                                           |
| Telemetry store              | append-only **JSONL** (pi's own `JsonlSessionStorage` idiom) — not sqlite; nothing in pi's dependency tree uses sqlite.                                                                                      |
| OTel spans                   | Optional **`pi-telemetry-otel`** Symbol registries — see the Telemetry section below.                                                                                                                        |

There are **no new extension runtime dependencies**. `pi-telemetry-otel` remains a separately installed companion: the
router consumes its global Symbol registries when present and no-ops when absent. Everything else above is exported by
pi's bundled packages. This removes extension-local `node_modules` installation without reducing schema validation,
inference, or tracing behavior.

## Framework

No web framework — this is a library plus a thin pi-extension adapter, not a service.

- **Integration surface:** `@earendil-works/pi-coding-agent`'s `ExtensionAPI`.
- **UI:** `@earendil-works/pi-tui`, for a `/route` status command modeled on the existing `extensions/effort`.
- **Classifier / continuity LLM calls:** `ExtensionAPI` itself has no one-shot inference method, but pi v0.80.7 exports
  `complete()` from `@earendil-works/pi-ai/compat`; pi's own `qna.ts` and `custom-compaction.ts` examples call it from
  extensions using a model plus `ctx.modelRegistry.getApiKeyAndHeaders()`. Use that proven path. The classifier exposes
  a tiny transport interface for deterministic tests, but production always uses `complete()` with one TypeBox schema
  tool, low temperature where supported, and validated tool arguments.
- **Provider access — registry-resolved, with Bifrost preferred where configured.** Production calls use the selected
  model's `baseUrl` and `ModelRegistry`-resolved auth. Deployments exposing models through Bifrost configure credentials
  in environment/settings and never hardcode them. Local pi installations may use an already-configured direct or OAuth
  endpoint. The eval harness is stricter: real eval calls require explicit `BIFROST_BASE_URL` and `BIFROST_VIRTUAL_KEY`
  so an evaluation cannot silently hit another endpoint.
- **Deterministic core** (eligibility, ranking, lease, compiler): a standalone TS module tree with **zero pi imports**,
  so it stays unit-testable in isolation and portable if the router is ever needed outside pi.

## Tooling

- **Runtime:** Node.js / ESM, matching pi's own `"type": "module"`. pi loads `.ts` extensions directly — no build step
  for the extension itself.
- **Tests:** `node --test` over strict `*.test.ts` files, executed with Node's native type stripping.
- **Schema/validation:** **TypeBox**, reused from pi's dependency tree through its canonical `typebox` / `typebox/value`
  exports — not Zod. One definition yields runtime validation (fail closed on malformed classifier output), static TS
  types, and the schema used for the required classifier tool call. No separate extension-local install is needed.
- **Telemetry — local JSONL store, plus OTel spans via `pi-telemetry-otel`:**
  - pi itself has **no OpenTelemetry plumbing to build on**. Its only telemetry is an install-ping toggle
    (`isInstallTelemetryEnabled`, gated by env `PI_TELEMETRY`); it reads no `OTEL_*` environment variables and
    instruments no spans, metrics, or logs itself. (Verified against pi v0.80.7's `dist/core/telemetry.d.ts` and its
    dependency tree — `@opentelemetry/api` is present only as a transitive dependency of an unrelated package, not one
    pi itself uses.)
  - There is, however, a dedicated companion extension for this:
    **[`pi-telemetry-otel`](https://www.npmjs.com/package/pi-telemetry-otel)** (`pi install npm:pi-telemetry-otel`,
    v0.1.1). It emits OpenTelemetry spans for pi's own session/ agent/turn/tool lifecycle to an OTLP/HTTP collector, and
    — the behavior we specifically want to fit to — its helper **automatically parents new spans under pi's
    currently-active span**, so our routing-decision spans nest into the live session/agent/turn trace rather than
    starting a disconnected trace. It honors the standard `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`, `OTEL_SERVICE_NAME`,
    `OTEL_RESOURCE_ATTRIBUTES` env vars (plus `PI_AGENT_TRACE_ID`/ `PI_AGENT_SPAN_ID` for subprocess linking), so it
    composes with a standard OTLP collector without router-specific exporter configuration.
  - **One resolution-decoupled integration path:** `pi-telemetry-otel` exposes
    `Symbol.for("pi.telemetry-otel.runtimeRegistry.v1")` (tracer/export pipeline) and
    `Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")` (active span context), keyed by
    `ctx.sessionManager.getSessionId()`. This needs no static import or copied dependency. A static `withPiSpan` import
    adds a second integration path with no additional capability, so it is intentionally omitted.
  - **Local JSONL remains the source of truth regardless of OTel configuration:** the spec's telemetry-promoted cost
    ranking requires the router to read its own history back in-process, and an OTel export is fire-and-forget to an
    external backend — it cannot be queried back for that purpose. No sqlite: nothing in pi's dependency tree uses it,
    and the retained history is small enough (one row per task boundary) that in-memory percentile computation over
    JSONL is sufficient.
  - Signal mapping: one **span** per routing decision (route key, archetype, model, effort, provider, confidence,
    boundary type, cache estimate), with child spans around each classifier LLM call (where the latency actually lives —
    this workload is I/O-bound, not compute-bound); span events for the audit ledger (every boundary signal, exclusion,
    score, fallback).
- **Lint/format:** use the repository-wide Prettier formatter and ESLint rules. Biome was removed after the repository
  adopted this toolchain so formatting and linting have one authority each.
- **Packaging:** install via the existing `scripts/install-extensions.sh`; `/reload` after reinstalling. Use the repo's
  `patches/` snapshot mechanism only if some required hook turns out not to be reachable through the public
  `ExtensionAPI` — unlikely, per the table above.

## Implemented directory layout

```text
extensions/router/
  core/                 # pure TS, zero pi imports — unit-testable, portable
    features.ts         # TypeBox semantic-feature schema
    synopsis.ts         # deterministic bounded context synopsis
    archetype.ts        # feature object -> route key
    routing.ts          # eligibility, headroom, review selection, and mature ranking
    fallback.ts         # bounded ordinary/review fallback state machines
    lease.ts            # task lease and boundary gate
    planning.ts         # typed PR-DAG validation
    profiles.ts         # versioned model-specific prompt profiles
    compiler.ts         # provider-aware prompt compiler
  eval/                 # offline corpus and explicit-Bifrost real-call suites
  classifier.ts         # semantic classification and conservative reconciliation
  pi-classifier.ts      # pi registry/auth transport via pi-ai complete()
  pi-state.ts           # persisted-state validation and pi metadata adapters
  telemetry.ts          # JSONL aggregates plus optional parented OTel spans
  index.ts              # pi lifecycle adapter, tools, and /route command
```

## Build sequence (completed)

1. `core/` first, with no pi imports — the deterministic spine, unit-tested directly against `SPEC.md`'s invariants.
2. `classifier.ts` — primary + provider-diverse secondary structured-output calls via pi-ai's `complete()` and
   registry-resolved auth; conservative reconciliation; validated single-stage failover; fail-closed routing block when
   the required output remains unavailable.
3. `index.ts` — the pi adapter: wire `input`/session boundary events to lease decisions; apply via
   `setModel`/`setThinkingLevel`; inject the compiled profile via `before_agent_start.systemPrompt`; map bootstrap
   aliases via `registerProvider`; add the `/route` status command.
4. `telemetry.ts` — local JSONL store (router reads this back in-process for ranking), plus `pi-telemetry-otel` spans
   via the Symbol-registry (falling back to no-op if that package isn't present/configured).
5. Ship in **shadow mode** first (log decisions without acting on them), per `SPEC.md`'s implementation sequence.

## Decision: explicit review kinds and irreversible-action authorization

Safety lifecycle is persisted in the lease as a discriminated v2 state. The router does not infer read-only behavior,
parent restoration, approval, or recursive-review eligibility from `parentLease`, archetype, or whichever model happened
to be selected previously.

Three review kinds have non-interchangeable effects:

- **Authorization review** evaluates a validated concrete plan before a high/critical-risk irreversible action. Only an
  exact-scope `approve` from a generated different-vendor review creates an execution lease. Reviewer failure,
  rejection, builder fallback, manual model/effort override, session change, compaction, new user input, or plan change
  cannot do so.
- **Advisory review** runs before other high-risk reversible non-code action. It supplies failure modes and safer
  sequencing but is not approval. This avoids turning every mutation into a hard authorization gate.
- **Completion review** runs after tracked high-risk work. Code builders must first supply attributable diff and passing
  deterministic-check evidence; the reviewer inspects that evidence rather than reviewing an intent-only plan.

Generated reviews know their parent builder, route across the two other vendors, expose only bounded read tools plus the
scoped verdict tool, and never fall back to the builder. Standalone review is orthogonal: it has no parent or fake
builder, collects a bounded read-only local/PR delta before classification, then uses feature-based `code_review` model
selection. It is an ordinary lease, may perform explicitly requested side effects, and cannot recursively trigger
completion review.

The irreversible preflight tool allowlist is deterministic. Unknown tools and shell composition are denied; after
approval, mutating tool names are limited to those in the reviewed plan. The plan and verdict schemas, canonical
fingerprints, lifecycle validation, and boundary invalidation are implemented locally. Pi's documented dynamic active-
tool API is used as a second, model-facing layer: action-plan and verdict validators are registered for execution but
activated only when the current lifecycle accepts them. No external safety-state-machine implementation or code was
consulted or adapted for this decision; the Pi API provenance is recorded in the root attribution file.

## Deferred follow-up: evidence-aware synopsis compaction

The synopsis keeps bounded, newest-first items and now removes excess recent outcomes, goals, and prior decisions in
round-robin order while retaining one item from each category. This is the appropriate deterministic policy today: it
prevents one category from being exhausted first without pretending that recency alone measures semantic value.

A priority queue or A* search is deliberately deferred. Neither has a trustworthy per-entry utility function yet, and
searching candidate summaries would add cost and nondeterminism without evidence of better routing or agent outcomes. A
future implementation must retain entry provenance and task linkage, evaluate progressive compaction candidates against
a fixed corpus (classifier/continuity agreement, downstream task success, and token cost), and promote a utility-scored
semantic summary only if it outperforms the deterministic round-robin baseline.

## Implementation-time findings (resolved)

1. **Classifier entrypoint:** use `complete()` from `@earendil-works/pi-ai/compat` with `ModelRegistry`-resolved auth.
   This is the same supported extension pattern used by pi's bundled examples; no private `Models` handle or direct
   provider SDK is needed.
2. **Telemetry resolution:** use the companion extension's Symbol registries only. This preserves parented spans when
   installed and deterministic no-op behavior otherwise, without another module root or runtime install step.
3. **Provider endpoint:** production classification uses the endpoint already resolved on the chosen pi model. A
   Bifrost-configured model therefore uses Bifrost; direct-provider configurations keep working. The real-call eval
   runner requires explicit `BIFROST_*` configuration and never silently changes endpoints.
4. **Concrete registry mapping:** policy v3 uses exact IDs present in pi v0.80.7's live registry
   (`gpt-5.6-{luna,terra,sol}`, `claude-{haiku-4-5,sonnet-5,opus-4-8,fable-5}`, `gemini-3.5-flash`) plus the configured
   `bifrost/bedrock/anthropic.claude-sonnet-5` endpoint as a Sonnet 5 availability alternative. These have version-aware
   profile families and deterministic lower-tier fallback resolution when a preferred exact ID is unavailable. Bifrost
   evaluation found its advertised Vertex 3.5 route unavailable in-region, so policy also lists exact
   `google-vertex/gemini-2.5-flash` behind 3.5 with a separate generation-specific profile.

## Evidence-driven policy revision, 2026-07-25 (`router-policy-v5`)

These decisions replace the hand-set priors of `router-policy-v4`. Each cites
[`model-evidence-2026-07-25.md`](model-evidence-2026-07-25.md), which carries the provenance and construct limits of
every number below. Benchmark pass rates are pre-telemetry ordering priors and never the router's acceptance signal.

1. **Manufacturer-first endpoints with same-model backups.** The model manufacturer's own route is the primary instance
   for a model; every other configured route for that model is an ordered availability backup placed ahead of any
   different-model fallback. Route price only orders endpoints inside one preference tier, and flat-rate GitHub Copilot
   endpoints are excluded from that comparison because their modeled token price is a capability proxy. Consequence:
   Claude Opus 5 has no Copilot route, so its Anthropic direct route is mandatory with Bedrock Global and regional
   profiles as backups.

2. **All Opus references move to Claude Opus 5; Opus 4.8 is retired.** Opus 5 beats Opus 4.8 at every tier (72.3% versus
   56.0% deterministic pass) at comparable cost per solved task ($8.42 versus $22.47), and Opus 5 at low effort
   outscores Opus 4.8 at max on CursorBench. Keeping a superseded generation as a lower tier would only add a
   worse-on-every-axis candidate.

3. **Ability is derived, not declared.** Bands come from the cross-source consensus percentile (>= 90 -> 4, >= 75 ->
   3, >= 45 -> 2, else 1). This moves Claude Sonnet 5 at high effort into the lowest band and removes it from the
   reviewer ladder, and it removes the name-based heuristic's treatment of "pro" and "max" as capability signals.

4. **Effort is a per-family, sometimes per-language, curve.** Opus 5 and Sol saturate at high; Terra needs max to be
   top-tier; Luna is cliffed and is agentic-viable only at max; Fable at max is excluded as measurably worse than Fable
   at xhigh; Sonnet 5 at xhigh and max are excluded for step and context thrash. Opus 5 additionally carries a
   TypeScript ceiling at high, because its measured TypeScript pass rate falls above that tier.

5. **Cost enters only as expected completion cost.** Pre-telemetry ordering seeds the existing robust cost-to-done shape
   from measured priors, with attempt cost equal to `costPerPassUsd * passRate`, the mean cost of one dispatched
   attempt, so failure is priced once by the intervention and retry terms. That product counts upstream failures which
   recorded no cost as zero, so it diverges from the corpus's own `mean_cost_usd` column by up to 6.1% on the
   `claude-fable-5` rows, which carry a 3.5-4.9% routing-error rate, and by under 0.5% on every other row. This is what
   keeps `gpt-5.6-terra` at low effort ($1.78 per pass, 24.1% pass) and `gpt-5.6-luna` at medium effort behind stronger
   configurations.

6. **Planning, program planning, and highest-risk advisory pin Opus 5.** These archetypes order by capability rather
   than expected completion cost, because their failure cost is paid by downstream pull requests rather than inside the
   task. The pin only reorders an authorized pool and is ignored when the pinned choice is ineligible. Every other
   archetype is ordered purely by measured cost-to-done, which on routine mixed-language work favors `gpt-5.6-sol` at
   high effort and on Go favors `claude-opus-5`.

7. **Language affinity is applied only where it is measured.** Go, Python, and TypeScript have DeepSWE coverage; the
   affinity is applied only when the repository resolves to exactly one of them. Kotlin, Ruby, HCL/Terraform,
   Kubernetes/Helm/Argo, protobuf, and Kafka have no coverage, so they receive no affinity and are routed by task shape
   with deterministic gates as the real authority. The TypeScript rows are library and browser-runtime evidence; no
   Next.js application or Vercel deployment task exists in the corpus, and the React-adjacent bucket is a labelled
   14-task proxy.

8. **Hard-task escalation changes the model prior instead of raising effort.** `gpt-5.6-luna` at max leads the corpus on
   hard tasks (44.6% corpus-wide, 47.1% on the Go/Python/TypeScript subset, 44.4% TypeScript) but has 52.7% same-task
   flakiness, so ambiguous work authorizes it as a retry candidate and it is explicitly demoted out of the primary slot.

9. **Quality floors are calibrated to achievable behavior.** The best measured deterministic pass rate is 72.8%, and a
   route cannot be accepted more often than it completes correctly, so implementation-class acceptance floors sit below
   that ceiling and telemetry can actually mature. Non-agentic floors are unchanged because the agentic corpus does not
   measure classification or extraction.

10. **Google narrows to one current-generation candidate.** `google-vertex/gemini-3.6-flash` at high effort replaces the
    3.5 and 2.5 entries, and `gemini-3.5-flash` and `gemini-3.1-pro-preview` are disqualified for measured context
    overflow and cost per pass. Google therefore contributes a single reviewer rung, and a builder above that band
    produces a recorded ceiling mismatch rather than a silent downgrade.

11. **Language affinity is scoped to what each source can support.** A declarative per-language table records, for every
    recognized language, whether its measured pass rate may enter scoring, an optional weak vendor tendency, a
    confidence level, and the numbers behind the decision. Go and Python substitute their measured pass rates;
    TypeScript does not, because its vendor gap is 1.4 points and single-source, so `gpt-5.6-sol` keeps TypeScript work
    on the uncontested latency and cost basis. Ruby contributes a near-tie preference only, bounded to a 5% cost band,
    because its single current-generation source has four single-file tasks measuring a Minitest pass ratio rather than
    a verifier outcome. Kotlin contributes nothing: its Java proxy was withdrawn once the generation-currency rule
    removed the GPT-5.2-era rows the apparent gap depended on. Ruby's real consequence is a mandatory `rubocop -a` gate,
    since the correctness leader is also the style laggard (12-17 offenses against 6-10 for the GPT-5.6 family).

12. **The balanced mid tier is admitted as fallbacks, not primaries.** `gpt-5.6-terra` at high, `gpt-5.6-luna` at high,
    `gpt-5.6-sol` at low, `gpt-5.6-sol` at medium, and `gpt-5.6-terra` at medium are the efficient mid-range
    configurations, and they enter the pools for the archetypes where their measured cost and latency can win. They are
    not pinned anywhere; the cost objective decides whether they beat a stronger tier on a given task.

13. **`gpt-5.6-luna`'s agentic minimum drops from max to high.** The original bar was set from the low and medium
    breakage rates (27.7% and 23.5%) without checking where the cliff actually is. At high effort breakage is 9.1%,
    comparable to `gpt-5.6-terra` at high (9.3%), which the policy already permits. Barring high effort was therefore
    unjustified.

14. **`gpt-oss-120b` is the cost floor for bounded work only.** It holds the corpus's top cost-efficiency percentile but
    has no agentic rollout evidence, a 128K window, a 16.4K output cap, and no image input, so it is authorized for
    classification and extraction and nothing else. Only the 120b variant is included; 20b measures lower with no
    cost-efficiency row, and the `safeguard` variants report no reasoning support. It is reachable only through Amazon
    Bedrock, making it the first candidate with no manufacturer tier, which endpoint expansion now models explicitly.

15. **Claude Opus 4.6 is retained as a scoped frugal candidate.** Cost per pass already internalizes token efficiency on
    billed routes, so frugality justifies a route only where steps rather than tokens bind. In the implemented policy
    that means one condition: an estimate consuming over half the endpoint's window. Outside it the candidate is
    excluded with a `scope_unmet` reason rather than left to rank late. A quota-surface step term was implemented and
    then removed during review, because `claude-opus-4-6` has no rollout row for the term to resolve and its activation
    condition left almost every archetype unroutable; the frugality rows remain as provenance only.

16. **Archetypes the corpus does not measure keep their declared order.** Widening the pools exposed that agentic priors
    were reordering `fast_classification` and `exact_extraction`. A multi-step repository pass rate is not a proxy for
    single-shot classification or schema extraction, so those archetypes use their pool for availability only.

17. **Minimum capability is gated on consequence, not on the archetype label.** The original bar used a static
    per-archetype `mutatesRepository` flag, which inverted in practice: `deliberate_tool_workflow` was marked
    non-mutating, so a task whose own action mode is `external_side_effect` had no capability bar while a reversible,
    test-covered edit got the strict one. The tier is now derived from `actionMode` and `risk`, with the archetype flag
    as a floor, and `irreversible` work additionally bars the lowest ability band. Regression cost is discounted by
    `verificationStrength` (0.85 self-check, 0.5 unit tests, 0.25 integration or policy), partially rather than fully,
    because a suite is not a complete guard against silent behavior change. Review is evaluated read-only so a builder
    can always review its own output, and every archetype must retain a candidate above the lowest band so
    high-consequence work stays routable.

18. **The candidate pool is derived from the operator's model scope.** The hand-maintained provider table was verified
    against a configured machine and was wrong in both directions: it named Bedrock profiles for Opus 5, `gpt-5.5` on
    the OpenAI route, and `gemini-3.6-flash`, none of which were scoped in, and it missed the routes that were. Policy
    now declares a logical model plus an effort, and endpoints resolve from the live registry filtered to
    `enabledModels`. Endpoint order is derived from provider tier, ID specificity, and route price rather than declared.
    A model with no scoped endpoint is reported as `not_in_scope`, which is a different fact from an endpoint being
    unavailable.

19. **Observed endpoint health gates eligibility.** `scripts/probe-scoped-models.ts` probes every scoped endpoint with a
    minimal real request; on the reference machine 32 of 34 worked, with two Llama 4 Bedrock profiles returning 400.
    Only recurring failures disqualify an endpoint, because a 4xx recurs until configuration changes while a 5xx or
    timeout is transient and removing the endpoint would shrink the fallback chain when it is most needed. Unprobed
    endpoints stay eligible so the router does not depend on a probe having been run.

20. **The Google rung is a preference chain so independent review always has a second vendor.** Review requires two
    non-builder vendors, and on a machine without `gemini-3.6-flash` the single declared Google candidate resolved to
    nothing, which would have made every review unroutable. The chain falls back to `gemini-2.5-pro` then
    `gemini-2.5-flash`: lowest-band reviewers, accepted because an independent second opinion from a weaker model beats
    no independent review, and review is read-only work where a weak reviewer cannot break anything. `gemini-3.5-flash`
    is excluded from the chain despite being scoped on the reference machine, because it is disqualified for a measured
    3.8% context-overflow rate.

21. **The previous-generation OpenAI core models are retired, and current-generation tiers take their slots.** Review
    asked why `gpt-5.4@medium` and `gpt-5.5@xhigh` were carried at all. They do not survive the question. `gpt-5.4` has
    no rollout row at `medium`, and the one tier the corpus does measure (`xhigh`) passes 51.8% with 12.4% regression
    breakage for $10.91 per pass — worse on every axis than `gpt-5.6-terra@high` (53.8%, 9.3%, $2.11). `gpt-5.5@xhigh`
    held the long-context slot on genuinely good context behavior (0% overflow, p90 peak 219,152, 83.1% partial credit),
    but `gpt-5.6-terra@max` matches that shape and beats it everywhere that matters: 69.6% pass against 67.0%,
    $7.10 per
    pass against $10.78, 928s median against 1,588s, consensus 84.7 against 68.8. Since the per-token price
    of the core tiers is comparable, a lower pass rate is simply more expensive once retries are counted, so both models
    are now disqualified as generation-superseded, on the same basis as `claude-opus-4-8`. Their replacements are
    `gpt-5.6-terra@high` in the deliberate ladder, `gpt-5.6-terra@max` in the long-context ladder, and
    `claude-opus-5@medium` as the deliberate ladder's non-OpenAI tail, which also ends that ladder being single-vendor.

22. **Hand-declared ability bands are gone.** `gpt-5.4@medium` was the only entry in the policy-local ability table, and
    it was a number no source backed. With it removed, every candidate must carry an evidence-derived band, from either
    a rollout row for that exact (model, effort) pair or the consensus-only table.

23. **A cheap small model is admitted as an explicitly unmeasured peer, not as a measured rung.** The bounded
    classification bucket already runs on `claude-haiku-4-5`, which itself has only a consensus figure and no agentic
    rollout row, so cheap unmeasured capability is not new there. `gpt-5.4-mini` is admitted beside it because per-token
    price is real and the live registry prices it at decision time — but the pack contains no row for any mini or nano
    model, so how it compares to Haiku is genuinely unresolved and is recorded as such rather than assumed favorable.
    The guardrails are structural instead of statistical: band 1 only, `fast_classification` and `exact_extraction`
    only, never a primary, ordered behind the rung it peers with, and refused outright by `core/routing.ts` whenever
    consequence is anything other than read-only — because the ability floor permits band 1 on reversible mutation, and
    there is no measurement here to argue a mutation is safe. `gpt-5.4-nano` is deliberately not admitted: the same
    argument would allow it, but a second unmeasured rung in one bucket buys no availability the first does not.

    The price argument is itself conditional on turn count, and is gated as such rather than assumed. `gpt-5.4-mini`
    runs at roughly 0.75 of `gpt-5.6-luna`'s per-token price, so break-even is 1 / 0.75 ≈ 1.33 turns: a run taking a
    third more turns than the model it undercuts has spent the whole discount, and beyond that it costs more. Since
    nothing measures how many turns it takes, the discount may only be spent where there is almost no room for turn
    inflation. `RoutingContext.singleShot` therefore requires both a `one_response` horizon and an expected turn budget
    of at most 2, and the peer is excluded with a stated reason otherwise. Both signals are required rather than either:
    a one-response horizon with a large turn estimate is still work that will iterate, and a small turn estimate on a
    longer horizon is a guess about only the first leg.

24. **No scenario-scoped effort allowlist was added, because the declared candidate refs already are one.** The
    considered change was a per-model list of the only efforts a model may be routed at, for models the corpus measures
    at a single tier. Research showed it was redundant: `authorizeEffort` has exactly one call site and is always passed
    an effort that policy enumerated on a `CandidateRef`, nothing raises effort dynamically (the escalation path is
    itself a declared ref), and `allowSuperSaturation` is true for only two archetypes whose ladders name only
    multi-tier-measured models. The one path that synthesizes a ref from live state is the fixed-builder review
    fallback, which uses the user's current effort — and capping it there would make review _skip_ rather than degrade,
    contradicting decision 20. Effort coverage therefore stays expressed as which (model, effort) pairs policy names.

25. **Disqualification is reserved for measured failure modes; superseded generations degrade instead.** Review pushed
    back on `claude-opus-4-8` being disqualified, and the objection holds: unlike `gemini-3.5-flash` (3.8% measured
    context overflow) or `gemini-3.1-pro-preview` (11.7% pass at
    $80.70), its exclusion rested on being beaten by Opus 5
    at every tier. That is an ordering fact the cost ranking already expresses, and enforcing it as a ban made a machine
    whose Anthropic catalog tops out at 4.8 *unroutable* for exactly the archetypes whose intent is "use the best Opus
    available". It is now the tail of an Opus generation chain on `implementation_planning`,
    `large_program_planning`, and `highest_risk_advisory`, with the preference for Opus 5 unchanged and enforced by three
    separate mechanisms: endpoint expansion tries every scoped Opus 5 route first with the manufacturer route ahead of
    gateways and resale, so an Anthropic outage degrades to Opus 5 elsewhere before the chain applies; the tail's own
    numbers rank it last (51.8% pass at $8.27
    per pass against Opus 5 at high with 72.3% at
    $8.42); and its effort is
    capped at `high`, including in the two archetypes that permit super-saturation, because its curve is flat and
    expensive above that (56.0% at max for $22.47).
    4.8 precedes 4.6 in the chain because it is the higher generation and is measured agentically, where 4.6 is retained
    only as the scoped frugal candidate.

Open items deliberately not taken: no unsupported-vendor candidates (Kimi, Grok, GLM, Muse) were added, and per-language
telemetry backfill for the unmeasured stacks remains the path to evidence for Kotlin, Ruby, and infrastructure work. The
unresolved comparison between `gpt-5.4-mini` and `claude-haiku-4-5` is the clearest next evidence gap: both are routed
on price alone, and a bounded classification eval would settle which belongs in front.
