# Scope-aware, cost-first endpoint routing with an Amazon Bedrock preference

Status: **in progress**. This document is the working plan and the todo ledger for the change. Update the checkboxes in
the same commit that lands each piece of work.

## Objective

Make the router's endpoint choice derive entirely from the operator's scoped, healthy registry, and replace tier-first
endpoint ordering with one cost-first comparator driven by a configurable per-provider route-weight table.

## Confirmed evidence

Every item below was verified against this repository, an identified `@earendil-works/pi-ai` registry, or vendor
documentation. Unless explicitly labelled as a live-runtime measurement, registry observations use the pinned
`@earendil-works/pi-ai@0.80.7` development package. That version does not contain `claude-opus-5`; the operator's live
runtime does, but its package revision was not captured. Nothing below silently treats those two registries as the same
source.

### Scope is already resolved; three things break it

- `readRouterScope` (`extensions/router/pi-state.ts`) reads `enabledModels` from `.pi/settings.json` then
  `~/.pi/agent/settings.json`, with a `PI_ROUTER_MODEL_SCOPE` override. `buildRegistrySnapshot` filters
  `ctx.modelRegistry.getAll()` through `matchesScope` and annotates availability plus probe health. `core/policy.ts`
  names only logical models, and `resolveEndpoints` expands them against that scoped registry.
- **Profile eligibility bypasses it.** `evaluateEndpoint` calls `findPromptProfile` with the _exact_ registry ID,
  matched against hand-written lists from `endpointIds(directId, bedrockPath)` which emits only `directId`,
  `global.<path>`, and `us.<path>`. Surveying the installed registry, **23 of 60** endpoints that canonicalize to a
  policy-named model resolve no profile and are excluded with `profile_missing`. **22 of the 23 are `amazon-bedrock`**,
  including every `anthropic.claude-opus-4-8` spelling, all bare `anthropic.claude-*` vendor-path forms, every
  `eu./au./jp.` profile, and `openai.gpt-5.6-luna` / `openai.gpt-5.6-terra`.
- **Ordering is tier-first, so price is structurally irrelevant.** `PROVIDER_TIERS` maps `amazon-bedrock` to `resale`,
  the last of `ENDPOINT_TIERS`, and both `resolveEndpoints` and `orderEndpoints` sort tier before price. A Bedrock route
  cannot take the primary slot at any price. `isFlatRateProvider` separately forces `github-copilot` last.
- **The classifier ignores scope.** `pi-classifier.ts` selects from `ctx.modelRegistry.getAvailable()` against a
  hardcoded provider/ID matrix, so it can call endpoints the operator never scoped in.

### Contract terms (operator-confirmed)

The 17% Amazon Bedrock discount is **off published list price** and **covers `cacheRead`, `cacheWrite`, and the 1-hour
cache-write rate**. It is a genuine marginal per-token reduction across every token class, not a commitment-based budget
effect, so it legitimately affects route choice.

### Why omitting cache terms from the blend is safe

Because the discount is a **uniform scalar across input, output, `cacheRead`, and `cacheWrite`**, the fixed
`0.25 * input + 0.75 * output` blend is **order-preserving for each exact Bedrock/first-party pair whose complete
list-rate vectors are equal**, not by approximation. Prefix alone does not establish parity: the surveyed
`au.anthropic.claude-opus-4-6-v1` vector is markedly higher than first party and must retain its exact registry rates.
For identical usage vectors under shared tokenization, cache eligibility, and applicable price tiers, no token mix or
cache hit rate can reverse a pair that satisfies the equality condition. Provider-specific token counts, cache classes,
eligibility, or tier boundaries require endpoint-specific pricing instead.

Supporting parity, measured in the pinned registry: positive short-write rates use `cacheRead/input = 0.10` and
`cacheWrite/input = 1.25` on the exact Anthropic and OpenAI model/provider pairs surveyed, including proportional
regional markups (`eu.anthropic.claude-sonnet-5`: input 2.2, cacheRead 0.22, cacheWrite 2.75). This is not universal
provider behavior: `gpt-5.4` and `gpt-5.5` use `cacheWrite: 0`, while `gpt-5.6-sol` uses `6.25` on its compared OpenAI,
Codex, Azure, Bedrock, and OpenCode routes; the pinned registry contains no `claude-opus-5` entry.

Supporting parity, in vendor docs: AWS and Anthropic both bill a 5-minute Claude cache write at 1.25x input and a read
at 0.1x, both default to a 5-minute TTL refreshed by hits at no charge, and both offer a 1-hour write at 2x input.
Bedrock cache reads additionally do not count against input-tokens-per-minute quotas. The cited AWS support table does
not list `claude-opus-4-8`, `claude-sonnet-5`, or `claude-fable-5`, and the pinned registry has no `claude-opus-5`, so
this evidence does not assert minimum-token or TTL support for those specific policy models.

### What a zero cache rate means

`Usage.cacheWrite` is a **required** `number` in `dist/types.d.ts:255`, `Usage.cacheWrite1h` is optional at line 257,
and `ModelCostRates.cacheWrite` is a **required** `number` around lines 586–591. `model.cost.cacheWrite` is never
`undefined` across 1,065 registry models, so `0` is the only value available for anything that is not a positive rate.
The ambiguity is a property of the schema. It is resolved as follows:

- `calculateCost` (`dist/models.js:186-204`) computes
  `cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6`. A `0` rate contributes exactly
  zero with **no fallback to the input rate**, so `0` means _no charge_ and never _no premium over base_.
- `cacheRead` disambiguates the rest: `cacheRead == 0 && cacheWrite == 0` means caching is unpriced or unsupported;
  `cacheRead > 0 && cacheWrite == 0` means caching exists with **no separate write line item**, which is the genuine
  OpenAI / Azure / Amazon Nova billing shape (`azure-openai-responses/gpt-4o`: input 2.5, cacheRead 1.25, cacheWrite 0).
- Anthropic's transport populates `usage.cacheWrite` from `cache_creation_input_tokens` and Bedrock's from
  `cacheWriteInputTokens`. OpenAI Responses and Completions transports also accept `cache_write_tokens` when a provider
  reports it, so a zero rate is not assumed to pair with zero usage. It still cannot leak charge: `calculateCost`
  multiplies every short-write count by the selected rate, and a zero rate contributes exactly zero.

The registry is **not** internally inconsistent about OpenAI cache writes. `gpt-5.4` and `gpt-5.5` carry `cacheWrite: 0`
on every provider, while `gpt-5.6-sol` carries `6.25` (exactly 1.25x) on `openai`, `openai-codex`,
`azure-openai-responses`, `amazon-bedrock`, and `opencode`, matching AWS documenting Bedrock's gpt-5.6 endpoints as
explicit-breakpoint caching. The only `0` entries for `gpt-5.6-sol` are the flat-rate `github-copilot` and the gateway
`cloudflare-ai-gateway`.

`cacheWrite1h` is a **usage** field with no rate anywhere in the registry, and `calculateCost` hardcodes the 1-hour
write as `rates.input * 2`. A provider weight applied to the **input** rate therefore discounts 1-hour cache writes
automatically, which is exactly what the contract terms require.

## Route-weight table

Ordering is by ascending weighted effective cost. Each entry declares a **basis**: `contract` asserts an actual price,
`preference` asserts only an ordering and makes no cost claim.

| Provider                  | Weight | Basis      | Reason                                                             |
| ------------------------- | -----: | ---------- | ------------------------------------------------------------------ |
| `amazon-bedrock`          |   0.83 | contract   | 17% off list, covering every token class and the 1-hour cache rate |
| `openai-codex`            |    1.0 | preference | first-party subscription route, preferred over metered `openai`    |
| `anthropic`               |    1.0 | preference | level with `openai-codex`                                          |
| `google`, `google-vertex` |    1.0 | preference | level with the other first-party routes                            |
| `bifrost`                 |    1.0 | preference | self-operated gateway, neutral                                     |
| `openai`                  |  1.001 | preference | strictly behind `openai-codex` at identical list price             |
| `github-copilot`          |    n/a | —          | **excluded from cost comparison** and ordered last; see below      |
| unknown provider          |   1.01 | preference | cannot silently outrank a known route                              |

Configuration uses `routerProviderWeights` in project `.pi/settings.json` and user `~/.pi/agent/settings.json`, with
`PI_ROUTER_PROVIDER_WEIGHTS` as a JSON-object override. Each provider value is either a number (basis `preference`) or
an object with own `weight` and `basis` (`contract` or `preference`) properties. Precedence is resolved independently
per provider in environment → project → user → built-in order. The inclusive validation band is **0.5 through 2.0**; an
invalid selected entry records a rejection and uses neutral `1.0` rather than recovering a lower-precedence value.

Measured result on the live registry: `gpt-5.6-sol` at Bedrock **19.712**, `openai-codex` **23.750**, `openai`
**23.774**. `claude-sonnet-5` at Bedrock `us.`/`global.` **6.640**, Bedrock `eu.` **7.304**, `anthropic` **8.000**.

`github-copilot` is excluded rather than penalised because its `cacheWrite: 0` classifies as `no_write_line_item` — it
is a flat-rate surface that does not bill token-level cache writes. That is direct evidence for the existing
evidence-pack position that Copilot token prices are capability proxies rather than costs, so any nominal weight would
be a false price statement.

### Guardrails that must survive

- Ordering runs strictly **after** eligibility. `amazon-bedrock/openai.gpt-5.6-sol` reports no `max` effort, so every
  `SOL_MAX` rung must still exclude it with `effort_unsupported`.
- `au.anthropic.claude-opus-4-6-v1` costs 66.00 blended (54.78 discounted) against 20.00 direct, so per-endpoint pricing
  is mandatory and it must never take the primary slot.
- Cross-model ranking is untouched. Cost enters model selection only as expected completion cost.
- Every eligible endpoint for the chosen model still precedes any different-model fallback.

## Pull-request DAG

Stack order is the topological order. `pr1` and `pr2` are independent and may be built in parallel worktrees; `pr3`
onward is a strict chain.

```text
main
 └── router/evidence-replace        (pr1)  ┐ independent
  └── router/canonical-profiles     (pr2)  ┘ independent
   └── router/endpoint-comparator   (pr3)  depends on pr1 + pr2
    └── router/provider-weights     (pr4)
     └── router/cost-first-ordering (pr5)  ← behaviour change, router-policy-v6
      └── router/scope-aware-classifier (pr6)
       └── router/scope-observability   (pr7)
```

## Todo ledger

### pr1 — Replace the routing evidence document

Branch `router/evidence-replace`. No dependencies.

- [x] Replace the former hand-maintained Markdown evidence narrative with a new dated document whose benchmark tables
      are **generated** from the checked-in `model-evidence-2026-07-25.json` rows, not transcribed.
- [x] Remove the three endpoint-pricing statements sourced from the absent external corpus.
- [x] Add `scripts/survey-endpoint-prices.mjs`: per logical model in `MODEL_VENDOR`, emit provider, exact ID, canonical
      ID, input/output/cacheRead/cacheWrite rates, the two cache ratios, price tiers, thinking levels, and blended cost,
      deterministically and offline.
- [x] Record the zero-cache-rate semantics rule with its evidence.
- [x] Record the generational `gpt-5.6` cache finding and explicitly retract the "registry is inconsistent" claim.
- [x] Record that `cacheWrite1h` has no rate and that `calculateCost` uses `input * 2`, so an input-rate weight
      discounts 1-hour writes automatically.
- [x] Record the contract terms, the order-preserving derivation, confirmed cache parity, and the documented GPT-5.6 TTL
      parity, with citations.
- [x] Re-point every inbound reference: `extensions/router/README.md`, `decisions.md`, `SPEC.md`, `eval.md`, the
      `evidence-data.ts` header, and citing comments in `core/evidence.ts` and `core/policy.ts`.
- [x] The evidence-data agreement test passes unchanged. `ATTRIBUTION.md` updated for the AWS and Anthropic sources.
- [x] `npm run check` passes.

### pr2 — Canonical-ID prompt-profile eligibility

Branch `router/canonical-profiles`. No dependencies. **Must not touch** `ATTRIBUTION.md` or the spec documents; `pr1`
owns those.

- [ ] Declare each `PromptProfile` against logical model IDs; remove `endpointIds()` and the `OPUS_5_IDS` /
      `SONNET_5_IDS` / `HAIKU_IDS` / `OPUS_48_IDS` variant lists.
- [ ] `findPromptProfile` canonicalizes its `modelId` before matching.
- [ ] Invariant test: for every logical model in `MODEL_VENDOR` and every archetype/effort pair policy can name, a
      profile resolves for a representative set of registry spellings from a **checked-in fixture**.
- [ ] Regression test: zero endpoints whose canonical ID is policy-named are excluded with `profile_missing`.
- [ ] Negative tests preserved and extended (`us.gov-cloud-widget-1` still resolves nothing).
- [ ] `isRouteChoice` and `leasedChoiceEligible` still reject a lease whose profile pairing has disappeared.
- [ ] `npm run check` passes, including the Bedrock-only Opus 5 scope cases in `core/routing.test.mjs`.

### pr3 — One endpoint comparator, effective cost, zero-rate classification

Branch `router/endpoint-comparator`. Depends on pr1 + pr2.

- [x] Single exported comparator used by both `resolveEndpoints` and `orderEndpoints`.
- [x] `effectiveCost = blendedEndpointCost(model) * providerWeight`, all weights 1.0 in this PR.
- [x] Three-valued cache classifier — `priced_write`, `no_write_line_item`, `caching_unpriced` — consumed everywhere
      instead of a bare `0`.
- [x] Test pinning pi's zero semantics: `calculateCost` charges nothing at a `0` rate and does not fall back to input;
      1-hour writes price as `input * 2`.
- [x] Cross-provider invariant over the enum, comparing only token-billing surfaces; Copilot and Cloudflare registered
      as expected `no_write_line_item`.
- [x] Test pinning the generational finding so a registry bump that flattens it fails loudly.
- [x] `RouteChoice.endpointEffectiveCost` optional, absent for flat-rate, so no lease-shape break.
- [x] Comparator is a **total order**: cost, then `endpointSpecificity`, then exact provider/ID string.
- [x] Bedrock GPT-5.6 Sol requests above 272,000 estimated finished tokens are rejected until that endpoint exposes a
      long-context rate; the short-context rate must never price larger requests.
- [x] Golden test: ordered endpoints and selected primary byte-identical before and after.
- [x] `npm run check` passes.

### pr4 — Configurable per-provider route weights

Branch `router/provider-weights`. Depends on pr3.

- [x] `RouterScope` gains a validated weight map with `PI_ROUTER_PROVIDER_WEIGHTS` → project → user precedence,
      best-effort reads.
- [x] Built-in defaults per the table above; each entry records `contract` or `preference`.
- [x] Validation rejects non-finite, zero, negative, and out-of-band values; keys read via the existing `ownProperty`
      guard; rejected entries fall back to 1.0 and are recorded.
- [x] Weights feed **only** `endpointEffectiveCost`; `robustCostToDone` and `scoreEvidencePrior` untouched.
- [x] Golden test: no route selection changes, since ordering is still tier-first.
- [x] Unit test pinning the measured effective costs.
- [x] `npm run check` passes.

### pr5 — Cost-first ordering, retire tier-first, `router-policy-v6`

Branch `router/cost-first-ordering`. Depends on pr4. **This is the behaviour change.**

- [x] Order by ascending weighted effective cost, then specificity, then ID. `ENDPOINT_TIERS` and `endpointTierFor` no
      longer participate; `endpointTier` retained as diagnostic metadata so `isRouteChoice` keeps validating it.
- [x] `github-copilot` excluded from cost comparison and ordered last, with the reason recorded in `decisions.md`.
- [x] Eligibility-before-ordering tests, including the `SOL_MAX` / `effort_unsupported` case.
- [x] `au.anthropic.claude-opus-4-6-v1` never takes the primary slot.
- [x] Cross-model ranking untouched; same-model grouping preserved; `validateFallbackTopology` and the tracked-review
      two-non-builder-vendor invariant still pass.
- [x] `POLICY_VERSION` → `router-policy-v6`; test asserts a persisted v5 lease is rejected.
- [x] `decisions.md` dated decision superseding decision 1 of `router-policy-v5`; `SPEC.md` updated where it asserts
      manufacturer-primary and within-tier-only pricing.
- [x] `README.md` documents the weight table, the discount scope, the Copilot exclusion, the zero-rate semantics, and
      the residency guidance. `ATTRIBUTION.md` updated.
- [x] Golden test records the new expected primary per archetype.
- [x] `npm run check` passes.

### pr6 — Scope-aware classifier

Branch `router/scope-aware-classifier`. Depends on pr5.

- [x] `selectClassifierModels` consumes the scoped, health-annotated snapshot from `buildRegistrySnapshot`.
- [x] Replace `FAST_PRIMARY_IDS` / `SECONDARY_IDS_BY_PRIMARY_VENDOR` with logical tiers resolved through
      `canonicalModelId` and ordered by the shared comparator.
- [x] Tier semantics preserved exactly, including cross-vendor independence of the secondary tier.
- [x] Unhealthy endpoints never called; abort still short-circuits.
- [x] Empty-scope path: classification fails cleanly, current selection retained, no premium route manufactured.
- [x] `npm run check` passes.

### pr7 — Scope, cost, and cache diagnostics, plus FW3

Branch `router/scope-observability`. Depends on pr6.

- [x] `/route scope` reports patterns and their source, resolved logical models, and per model each eligible endpoint in
      selection order with list cost, applied weight, basis, cache classification, and effective cost.
- [x] Excluded endpoints listed with their `ExclusionCode` and detail.
- [x] Telemetry gains `endpointEffectiveCost`, applied weight, basis, and cache classification; store stays append-only
      and older records still parse.
- [x] Attempt outcomes record observed `cacheRead` / `cacheWrite` token counts per endpoint.
- [x] `future-work.md` gains **FW3** for the one residual cache question: whether Bedrock and OpenAI direct yield
      materially different observed `cacheRead` ratios despite both documenting a 30-minute minimum TTL for GPT-5.6. It
      cannot change Bedrock-versus-first-party ordering, and the pr3 invariant reads registry rates so it would not
      detect a behavioural divergence.
- [x] Output bounded; secretlint passes over the telemetry path.
- [x] `npm run check` passes.

## Rollout

`pr1` through `pr4` are behaviour-neutral and gated by byte-identical golden tests. `pr5` is the behaviour change: land
it with routing in **shadow mode**, which logs and displays the route without changing the model, inspect `/route` and
telemetry on at least one real repository, then enable active routing per repository through `repo-router-config`.

## Rollback

- `pr1`–`pr4`: revert the commit. Nothing persisted depends on them.
- `pr5`: revert to restore tier-first ordering and `router-policy-v5`; leases created under v6 are then discarded by the
  version check, which is the intended fail-safe. Partial mitigation without a deploy is to raise the `amazon-bedrock`
  weight above 1.0 where its list rates match direct, or scope Bedrock out when it must be excluded. A weight of exactly
  1.0 removes only the contract discount and leaves deterministic tie-breaks authoritative. None of these mitigations
  restores tier-first ordering, because there is deliberately no dual-mode switch.
- `pr6`–`pr7`: revert. Telemetry consumers tolerate absent fields because the store is append-only JSONL.

## Open unknowns

- The registry's long-context tier on `openai` / `openai-codex` `gpt-5.6-*` has no Bedrock equivalent. This is now the
  only unmodelled pricing asymmetry, and unlike cache terms it is **not** a uniform scalar, so it could affect ordering
  above 272K input tokens.
- Whether Bedrock and OpenAI direct produce different GPT-5.6 cache-hit rates despite their documented 30-minute
  minimum-TTL parity. Tracked as FW3.
- pi hardcodes the 1-hour write as `input * 2`; if a provider deviates, pi mis-prices it and the router inherits that.
- Bedrock latency, throughput, and throttling versus first-party routes are unmeasured here, though Bedrock cache reads
  not counting against input TPM quotas is a documented point in its favour.
- Whether weights should be expressible per `(provider, model)` or per region profile, given
  `au.anthropic.claude-opus-4-6-v1` diverges inside one provider.
- Whether pi's registry generator can emit `0` for a rate it merely does not know. The `Cost` type makes that
  indistinguishable at rest, so the pr3 classification is a best-available inference from `cacheRead`.
