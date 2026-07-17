# Routing layer — architecture decisions

Companion to [`SPEC.md`](SPEC.md) (the functional spec) and [`eval.md`](eval.md) (the evaluation
harness). This document records *how* it will be built and why — language, framework, tooling —
plus the open items to confirm before implementation starts. Not implemented yet.

## Decision: TypeScript, in-process, as a pi extension

The workload is **LLM-I/O-bound**, not compute-bound: the deterministic core (eligibility filter,
ranking, lease state machine, prompt compiler) runs once per task boundary over kilobytes of data —
microseconds to low milliseconds of work — while every classifier call and model turn is a
multi-second network round trip. A faster core language buys effectively zero wall-clock; there is no
hot loop to justify one.

What *is* recurring cost is the **per-turn integration boundary**: the router is consulted on every
user turn. Running out-of-process (e.g. the reference implementation's Python, as a sidecar) would
mean IPC plus full harness-state serialization (session, tokens, tool inventory, builder identity,
cache stats) on every turn. Running in-process in pi's own runtime avoids that entirely.

pi's `ExtensionAPI` (`@earendil-works/pi-coding-agent`, verified against v0.80.7's
`dist/core/extensions/types.d.ts`) already exposes every hook this spec's pipeline needs:

| Spec requirement | pi `ExtensionAPI` primitive |
|---|---|
| Only a user-input turn triggers boundary evaluation | `on("input", …)` |
| Hard boundaries: new window / post-compaction / subagent | `session_start`, `session_compact`, `session_before_fork` |
| Exact token counts & context-window feasibility | `ctx.getContextUsage()` → `ContextUsage` |
| Model eligibility, context window, cost, API keys | `ctx.modelRegistry` / `ModelRegistry` |
| Builder identity (for independent review routing) | `ctx.model` |
| Apply the lease (model + effort) | `setModel(model)`, `setThinkingLevel(level)` |
| Inject the compiled model-specific prompt profile | `before_agent_start` → `systemPrompt` result |
| Map bootstrap aliases → real endpoints | `registerProvider(...)` |
| Persist/reevaluate the lease across turns | `appendEntry` + re-check on `input` |

The existing extensions in this repo (`extensions/{clear,effort,markdown-backlinks}`, each
`index.ts` + `helpers.ts` + `index.test.mjs`) already demonstrate the shape this layer should take.

**The prose functional spec (`SPEC.md`) is the implementation authority — not the external Python
reference router.** That reference is untested and untrialed; treat it as informal illustration only,
and do not conform to its output shapes, schemas, or behavior. Tests should be authored directly from
`SPEC.md`'s invariants, not as a diff against the reference.

## Why not an agent framework

Not LangChain, CrewAI, LangGraph, or the Anthropic/OpenAI Agents SDKs. What we're building is a
**router** — a classifier plus a deterministic decision engine plus a prompt compiler — not an agent:
there is no agentic loop, tool orchestration, or multi-agent coordination to own, because pi already
is the agent and owns the loop. Dropping an agent framework in would fight the in-process integration
described above and add a heavy abstraction around what is, on the LLM side, a single low-temperature
structured-output classification call. This also matches how Upstart treats these frameworks
internally: the Anthropic/OpenAI Agents SDKs and CrewAI are explicitly experimental/prototyping-only
there, and the company's real agent investment (LangGraph, the `upstart-genai-platform` SDK) is
Python-only with no TypeScript equivalent — so there's neither a good reason nor an internal
convention to reuse here.

## Dependency set

pi's bundled packages already cover nearly the entire runtime surface. Reuse them; do not add
equivalents:

| Need | Reuse (already available) |
|---|---|
| Schema/validation | **TypeBox**, re-exported from `@earendil-works/pi-ai`: `import { Type, type Static, type TSchema } from "@earendil-works/pi-ai"`. Not Zod — TypeBox is a first-class pi dependency and matches pi's own `ToolDefinition` model. |
| Structured classifier output | forced **tool call** with TypeBox parameters, validated via pi-ai's `validateToolCall`/`validateToolArguments` (+ `parseJsonWithRepair` for recovery). There is no `response_format`-style enforcement path. |
| One-shot LLM call | pi-ai's `Models.completeSimple()` / `.complete()` — **preferred if reachable from an extension**; see Open items. |
| Provider access | **Bifrost** (Upstart's sanctioned AI gateway) — see the Provider access section below. |
| Token/context sizing | `ctx.getContextUsage()` + pi-ai's `estimateContextTokens`/`calculateCost` helpers. No tiktoken — pi has no real tokenizer, and estimation is the norm here. |
| Eligibility/ranking inputs | `ctx.modelRegistry.getAvailable()`/`.find()`, `Model.{cost,contextWindow,maxTokens,reasoning}`, pi-ai's `calculateCost()`. |
| Lease/state persistence | `pi.appendEntry()` (per-session custom entries) + `getAgentDir()`. |
| Telemetry store | append-only **JSONL** (pi's own `JsonlSessionStorage` idiom) — not sqlite; nothing in pi's dependency tree uses sqlite. |
| OTel spans | **`pi-telemetry-otel`** — see the Telemetry section below. |

The only **new runtime dependency** is `pi-telemetry-otel`. Everything else in the table above is
already present in pi's own dependency tree. New **dev-only** tooling (typecheck/lint/test) is a
separate, later concern and never ships — the installer copies raw `.ts` and pi loads it via `jiti`.

## Framework

No web framework — this is a library plus a thin pi-extension adapter, not a service.

- **Integration surface:** `@earendil-works/pi-coding-agent`'s `ExtensionAPI`.
- **UI:** `@earendil-works/pi-tui`, for a `/route` status command modeled on the existing
  `extensions/effort`.
- **Classifier / continuity LLM calls:** `ExtensionAPI` itself has no one-shot inference method.
  Preferred path: pi-ai's `Models.completeSimple()`/`.complete()`, **if an extension can obtain a
  `Models` handle** — this is unverified; the interface exists in pi-ai's `.d.ts` but nothing found so
  far shows how an extension instance reaches it (`ctx.modelRegistry` is a `ModelRegistry`, a
  different type, exposing auth/availability rather than inference). Fallback, and the path with no
  open question: use the provider SDKs pi-ai already bundles (`openai`, `@anthropic-ai/sdk`) directly,
  authenticated via `ctx.modelRegistry.getApiKeyAndHeaders()`, pointed at Bifrost. Either way the call
  stays "a fast model, low temperature, no tools other than the schema tool-call, response validated"
  as the spec requires. Confirm the reachable path at build time (see Open items).
- **Provider access — Bifrost.** Point calls at Upstart's sanctioned AI gateway rather than a
  provider endpoint directly: base URL `https://bifrost.upstart.com` (staging:
  `https://bifrost-s1.upstart.com` / `-s2`), OpenAI-compatible path `/v1` or native `/anthropic`,
  authenticated with a virtual key (`sk-bf-...`) as the SDK `api_key` or an `x-bf-vk` header.
  Provision a key via the `/bifrost-virtual-key` skill (`llm-dev-tools` Claude Code plugin) or
  `#ask-bifrost-gateway`; read it from env (`BIFROST_BASE_URL` / `BIFROST_VIRTUAL_KEY`), never
  hardcode it. If the `completeSimple` path above is reachable, wire it through pi-ai's
  `registerProvider(name, { baseUrl, apiKey, api })` pointed at Bifrost; if using the SDK fallback,
  point the SDK's own `baseURL`/`apiKey` at Bifrost instead.
- **Deterministic core** (eligibility, ranking, lease, compiler): a standalone TS module tree with
  **zero pi imports**, so it stays unit-testable in isolation and portable if the router is ever
  needed outside pi.

## Tooling

- **Runtime:** Node.js / ESM, matching pi's own `"type": "module"`. pi loads `.ts` extensions
  directly — no build step for the extension itself.
- **Tests:** `node --test` over `*.test.mjs`, matching this repo's existing convention.
- **Schema/validation:** **TypeBox**, reused from pi-ai's own dependency tree
  (`import { Type, type Static, type TSchema } from "@earendil-works/pi-ai"`) — not Zod. One
  definition yields runtime validation (fail closed on malformed classifier output), static TS
  types, and the schema used for the forced tool-call. No new validation dependency needed.
- **Telemetry — local JSONL store, plus OTel spans via `pi-telemetry-otel`:**
  - pi itself has **no OpenTelemetry plumbing to build on**. Its only telemetry is an install-ping
    toggle (`isInstallTelemetryEnabled`, gated by env `PI_TELEMETRY`); it reads no `OTEL_*`
    environment variables and instruments no spans, metrics, or logs itself. (Verified against pi
    v0.80.7's `dist/core/telemetry.d.ts` and its dependency tree — `@opentelemetry/api` is present
    only as a transitive dependency of an unrelated package, not one pi itself uses.)
  - There is, however, a dedicated companion extension for this: **`pi-telemetry-otel`**
    (`pi install npm:pi-telemetry-otel`, v0.1.1). It emits OpenTelemetry spans for pi's own session/
    agent/turn/tool lifecycle to an OTLP/HTTP collector, and — the behavior we specifically want to
    fit to — its helper **automatically parents new spans under pi's currently-active span**, so our
    routing-decision spans nest into the live session/agent/turn trace rather than starting a
    disconnected trace. It honors the standard `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`,
    `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` env vars (plus `PI_AGENT_TRACE_ID`/
    `PI_AGENT_SPAN_ID` for subprocess linking) — this is exactly Upstart's standard OTel→Datadog
    path (via the in-cluster OTel Collector / `corp-otel-gateway`), so no bespoke config to invent.
  - **Two integration paths, in preference order:**
    1. **Primary — the Symbol-registry.** `pi-telemetry-otel` exposes
       `Symbol.for("pi.telemetry-otel.runtimeRegistry.v1")` (tracer/export pipeline) and
       `Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")` (active span context), keyed
       by `ctx.sessionManager.getSessionId()`. This is **resolution-decoupled** — it needs no static
       import of the package, so it works even if a copied-`.ts` extension can't resolve
       `pi-telemetry-otel` as a module. Prefer this as the primary hook.
    2. **Secondary — `withPiSpan`.** `import { withPiSpan } from "pi-telemetry-otel/helpers"` gives
       a cleaner call (`await withPiSpan(ctx, "router.route", async (span) => { span?.setAttribute(...) })`),
       but requires the package to resolve as a static import under `jiti` from a `.ts` file copied
       into the agent dir — **unverified**; use it only once that resolves (see Open items).
  - **Local JSONL remains the source of truth regardless of OTel configuration:** the spec's
    telemetry-promoted cost ranking requires the router to read its own history back in-process,
    and an OTel export is fire-and-forget to an external backend — it cannot be queried back for
    that purpose. No sqlite: nothing in pi's dependency tree uses it, and the retained history is
    small enough (one row per task boundary) that in-memory percentile computation over JSONL is
    sufficient.
  - Signal mapping: one **span** per routing decision (route key, archetype, model, effort, provider,
    confidence, boundary type, cache estimate), with child spans around each classifier LLM call
    (where the latency actually lives — this workload is I/O-bound, not compute-bound); span events
    for the audit ledger (every boundary signal, exclusion, score, fallback).
- **Lint/format:** match the repo's existing style — confirm the active formatter before writing
  code (the existing extensions read as tab-indented / Biome-style).
- **Packaging:** install via the existing `scripts/install-extensions.sh`; `/reload` after
  reinstalling. Use the repo's `patches/` snapshot mechanism only if some required hook turns out not
  to be reachable through the public `ExtensionAPI` — unlikely, per the table above.

## Proposed directory layout

```
extensions/router/
  core/                 # pure TS, zero pi imports — unit-testable, portable
    features.ts         # TypeBox feature schema, reused from @earendil-works/pi-ai
    synopsis.ts         # deterministic context-synopsis builder
    archetype.ts        # feature object -> route key (archetype map)
    eligibility.ts      # availability + 70% context-headroom filter
    ranking.ts          # robust cost-to-done; secondary OpenAI/Anthropic rule
    lease.ts            # task-lease state machine (boundary-only evaluation)
    profiles.ts         # model-specific prompt-profile registry
    compiler.ts         # provider-aware prompt compiler (verbatim user request)
  classifier.ts         # primary + provider-diverse secondary via Bifrost (pi-ai or SDK fallback)
  telemetry.ts          # local JSONL store, plus pi-telemetry-otel spans (Symbol-registry primary)
  index.ts              # pi ExtensionAPI adapter + /route TUI command
  index.test.mjs        # + core/*.test.mjs
```

## Build sequence (for when this is implemented)

1. `core/` first, with no pi imports — the deterministic spine, unit-tested directly against
   `SPEC.md`'s invariants.
2. `classifier.ts` — primary + provider-diverse secondary structured-output calls against Bifrost
   (via pi-ai's `completeSimple` if reachable, else the bundled-SDK fallback); conservative
   reconciliation; fail-closed fallback route.
3. `index.ts` — the pi adapter: wire `input`/session boundary events to lease decisions; apply via
   `setModel`/`setThinkingLevel`; inject the compiled profile via `before_agent_start.systemPrompt`;
   map bootstrap aliases via `registerProvider`; add the `/route` status command.
4. `telemetry.ts` — local JSONL store (router reads this back in-process for ranking), plus
   `pi-telemetry-otel` spans via the Symbol-registry (falling back to no-op if that package isn't
   present/configured).
5. Ship in **shadow mode** first (log decisions without acting on them), per `SPEC.md`'s
   implementation sequence.

## Open items to confirm before implementation

These refine *how*, not *whether* — the language/architecture decision above is settled regardless
of how they resolve.

1. **Classifier inference entrypoint.** Confirm whether an extension can obtain a pi-ai `Models`
   handle to call `completeSimple()`/`complete()` directly, or must go through the bundled SDK
   (`openai` / `@anthropic-ai/sdk`) authenticated via `ctx.modelRegistry.getApiKeyAndHeaders()` and
   pointed at Bifrost. The interface exists in pi-ai's `.d.ts`; the reachability from inside an
   extension is unverified.
2. **`pi-telemetry-otel` import resolution.** Confirm whether the package resolves as a static
   import (`import { withPiSpan } from "pi-telemetry-otel/helpers"`) under `jiti` from a `.ts` file
   copied into the agent dir. If not, use its Symbol-registry hooks
   (`Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")` /
   `…runtimeRegistry.v1"`), which need no static import and are the primary integration path either
   way (see Tooling above).
3. **Bifrost integration shape.** Confirm `registerProvider` (if the pi-ai path above is reachable)
   accepts Bifrost's OpenAI-compatible base URL and `sk-bf-...` virtual key without modification, or
   whether the native `/anthropic` path is preferable for the classifier's tool-call structured
   output. Provision a virtual key via the `/bifrost-virtual-key` skill before testing either path.
4. **Concrete model registry mapping.** The archetype → model priors table in `SPEC.md` intentionally
   omits concrete model IDs; resolve each archetype's bootstrap choice against pi's actual
   `ModelRegistry` contents at build time, not from any external document's example names.
