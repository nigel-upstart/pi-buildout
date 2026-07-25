# Router model evidence — capture 2026-07-25

This document and its companion [`model-evidence-2026-07-25.json`](model-evidence-2026-07-25.json) are the checked-in
evidence basis for the router's bootstrap priors. Policy changes cite this file rather than analysis performed
elsewhere.

The JSON is the machine-readable authority consumed by [`core/evidence.ts`](../../extensions/router/core/evidence.ts).
This Markdown file explains where each field came from, what it can support, and what it cannot.

## Provenance

| Field group   | Source                                                       | Capture    | Construct                                                    |
| ------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------ |
| `deepswe`     | DataCurve DeepSWE v1.1 rollout snapshot (22,586 trials)      | 2026-07-25 | `mini-swe-agent` deterministic verifier outcomes per rollout |
| `byLanguage`  | Same snapshot, grouped by DataCurve task language attributes | 2026-07-25 | Same, restricted to a language bucket                        |
| `cursorbench` | CursorBench 3.2 public leaderboard                           | 2026-07-24 | Correctness on ambiguous multi-file Cursor tasks             |
| `consensus`   | `report-data.json` `model_consensus`, normalization v2.0     | 2026-07-25 | Within-source percentile consensus across three benchmarks   |

Upstream corpus: `~/outputs/llm-effectiveness`. The derivation for `deepswe` and `byLanguage` is
`analysis/router_capability_slices.py` in that corpus, which writes
`analysis/derived/router_capability_slices{,_by_language_bucket}.csv`. The interpretation is recorded in that corpus's
`ROUTING_LEARNINGS.md`. Attribution is recorded in this repository's [`ATTRIBUTION.md`](../../ATTRIBUTION.md).

## What these numbers are, and are not

1. **They are ordering priors, not guarantees.** DeepSWE trials ran on the `mini-swe-agent` harness, not on pi. They
   rank candidates before router telemetry matures; measured pi telemetry supersedes them.
2. **`passRate` is a deterministic verifier outcome, not acceptance.** It must never be substituted for the router's
   `acceptedRate` telemetry, which is the signal the quality floors consume.
3. **`regressionBreakRate` is the fraction of produced patches that broke previously passing tests.** It is the corpus's
   best available proxy for silent breakage in protobuf compatibility, Terraform blast radius, Helm/Argo drift, and
   Kafka contract changes.
4. **Claude Fable 5 rows carry a 3.5–4.9% `routingErrorRate`** from `vertex_ai` routing failures in the source snapshot,
   so Fable's measured deficit against Opus 5 is an upper bound on the real gap.
5. **GitHub Copilot prices in the corpus are capability proxies for a flat-rate product.** No cost field here is a
   Copilot cost, and Copilot endpoints are excluded from cost tiebreaks.
6. **Vendors outside the router's supported set inform context only.** Kimi K3, Grok 4.5, GLM 5.2, and Muse Spark are
   not candidates; Grok additionally carries Cursor's training-contamination disclosure.
7. **A corpus-wide generation-currency rule governs admission.** A source is retained only if it contains at least one
   Anthropic Claude >= 4.5 or OpenAI GPT >= 5.4 row, and within an admitted source only Claude >= 4.5, GPT >= 5.4,
   Gemini >= 3.0, and `gpt-oss` rows are retained. This rule removed all three OpenAI submissions from SWE-bench
   Multilingual, which in turn withdrew three claims that had looked like cross-vendor findings but were really
   cross-generation ones. A cross-source check is only a check when both sources carry both vendors at a comparable
   generation.
8. **Low-sample buckets must not be weighted equally.** `web_ui_proxy` is 14 tasks and is a labelled proxy, not React or
   Next.js evidence. Rust and JavaScript (5 tasks each) are excluded from this file's language buckets entirely.

## Coverage against the Upstart stack

`upstart_core` is Go + Python + TypeScript: 103 of the 113 DeepSWE tasks.

| Upstart area                                            | Coverage                  | Status     |
| ------------------------------------------------------- | ------------------------- | ---------- |
| Go                                                      | 34 tasks                  | measured   |
| Python (incl. data engineering, AI workflow automation) | 34 tasks                  | measured   |
| TypeScript (Vercel frontend, React/Next.js, AWS CDK)    | 35 tasks                  | measured   |
| React-adjacent / browser runtime                        | 14 tasks (`web_ui_proxy`) | proxy only |
| Kotlin, Ruby                                            | 0 tasks                   | unmeasured |
| HCL/Terraform, Kubernetes/Helm/Argo, protobuf, Kafka    | 0 tasks                   | unmeasured |

The 35 TypeScript and 5 JavaScript tasks are library, parser, ORM, CLI, and browser-runtime repositories (Effect,
TanStack Query, Drizzle, Kysely, valibot, arktype, ts-pattern, happy-dom, vitest, quill, ink, koota, yjs, ofetch,
csstree, KaTeX). **No Next.js application, App Router, RSC, SSR, or Vercel deployment task exists in the corpus.** The
TypeScript numbers are therefore strong evidence for typed TypeScript library and API-surface work and only proxy
evidence for React component and Next.js application work.

### Per-language policy

| language   | pass-rate substitution | vendor tendency | confidence | basis                                                                                            |
| ---------- | ---------------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| Go         | yes                    | Anthropic       | measured   | 6.6 point vendor gap at high effort, 40 point hard-task gap, and the hardest language of eight   |
| Python     | yes                    | none            | measured   | vendor-neutral on pass rate; carries the corpus's highest regression breakage at an 11.8% median |
| TypeScript | **no**                 | none            | measured   | 1.4 point single-source gap; Sol leads on the uncontested latency and cost basis instead         |
| Ruby       | **no**                 | Anthropic       | low power  | four single-file tasks measuring a Minitest pass ratio; 74-77% floor versus 57.1% for Sol        |
| Kotlin     | no                     | **none**        | none       | no retained evidence; the Java proxy was withdrawn as a cross-generation comparison              |

A vendor tendency may only break a near-tie inside a 5% cost band. It can never move a candidate past a materially
better score, and it never claims a language-specific pass rate.

Ruby's practical consequence is a gate rather than a model swap: Anthropic averages 12-17 RuboCop offenses against 6-10
for the GPT-5.6 family, so Ruby routes to Opus 5 with `rubocop -a` as a mandatory deterministic gate, exactly as
Terraform work gets `terraform validate` and protobuf work gets `buf breaking`.

Unmeasured areas get **no language affinity modifier**. They are routed by task shape — output rigidity, blast radius,
verification strength, regression sensitivity — and their real authority is the deterministic gate
(`terraform validate`/`plan`, `helm template`, `kubeconform`, `argo lint`, `buf lint`/`breaking`, `cdk synth`/`diff`),
which already outranks any LLM verdict under [`SPEC.md`](SPEC.md).

## Findings the policy encodes

### Generation currency outranks effort escalation

| config                 | pass  | $/pass | regression break | median s |
| ---------------------- | ----- | ------ | ---------------- | -------- |
| `claude-opus-5@high`   | 72.3% | $8.42  | 4.9%             | 1009     |
| `claude-opus-4-8@max`  | 56.0% | $22.47 | 6.0%             | 2953     |
| `claude-sonnet-5@high` | 48.2% | $15.36 | 7.1%             | 1539     |

Opus 5 at **low** effort (CursorBench 62.8) outscores Opus 4.8 at **max** (62.3). Opus 4.8 is therefore retired from
bootstrap priors rather than retained as a lower tier.

This also reconciles two `report-data.json` recommendations. "Use Sonnet as the routine Claude tier; make Opus an
escalation" carries confidence **0.64** and is explicitly scoped to the AWS subset with Opus 4.x per-token evidence.
"Optimize accepted-output cost, not raw token price" carries confidence **0.88**. For agentic multi-step coding the
second governs: on cost per solved task, Opus 5 beats Claude Sonnet 5 at every Sonnet effort. The Sonnet-routine
guidance remains valid for non-router, per-token estate traffic.

### Vendor preference is language-conditional

| bucket              | best measured                                           | hard-task leader         | reading                               |
| ------------------- | ------------------------------------------------------- | ------------------------ | ------------------------------------- |
| Go (34)             | `opus-5@xhigh` 85.9, `opus-5@high` 81.6, `sol@max` 78.7 | `opus-5@high` **71.9**   | decisive Anthropic edge               |
| Python (34)         | `sol@xhigh` 75.0, `opus-5@max` 74.3, `sol@max` 74.3     | `opus-5@medium` **53.1** | neutral on average, Anthropic on hard |
| TypeScript (35)     | `sol@high` 65.7, `sol@max` 65.7, `terra@max` 65.5       | `luna@max` **44.4**      | OpenAI edge on average                |
| `web_ui_proxy` (14) | `sol@high` 67.9, `opus-5@high` 66.1                     | `opus-5@high` **58.3**   | consistent with TypeScript            |

On hard Go tasks `opus-5@high` solves 71.9% where `sol@max` solves 31.2%. Nothing else in the corpus separates two
vendors by that margin. On TypeScript, `sol@high` wins the average with roughly half the wall time, while `opus-5@high`
wins the hard tail. The router is therefore bi-vendor per task, not Anthropic-default.

### Effort is a per-family, and sometimes per-language, curve

| family         | low  | medium | high | xhigh    | max  | reading                                    |
| -------------- | ---- | ------ | ---- | -------- | ---- | ------------------------------------------ |
| Claude Opus 5  | 57.7 | 68.1   | 72.3 | 72.5     | 72.8 | saturates at high                          |
| GPT-5.6 Sol    | 45.4 | 61.1   | 69.2 | 70.6     | 72.3 | saturates near high                        |
| GPT-5.6 Terra  | 24.1 | 35.1   | 53.8 | 60.2     | 69.6 | effort-hungry; only competitive at max     |
| GPT-5.6 Luna   | 1.5  | 11.3   | 44.2 | 56.9     | 67.2 | cliff at the bottom                        |
| Claude Fable 5 | 57.1 | 63.1   | 65.3 | **69.9** | 67.3 | **non-monotonic**: max is worse than xhigh |

Fable at max is strictly worse than Fable at xhigh (67.3 vs 69.9 pass, 64.9% vs 79.9% partial credit) at $30.74 vs
$19.02
per pass. On TypeScript specifically, Opus 5 **degrades above high** (high 64.3, xhigh 60.7, max 63.3), so the
saturation ceiling has a language-conditional override.

### Regression risk is concentrated in Python

| bucket                 | median break rate | range     | safest configs at pass ≥ 55%                                   |
| ---------------------- | ----------------- | --------- | -------------------------------------------------------------- |
| `web_ui_proxy` (proxy) | 1.8%              | 0.0–5.5%  | `sol@high` 0.0, `opus-5@high` 0.0, `fable-5@xhigh` 0.0         |
| TypeScript             | 5.0%              | 0.7–27.1% | `sol@high` 1.4, `fable-5@medium` 1.4, `opus-5@high` 1.4        |
| Go                     | 5.9%              | 2.2–20.6% | `opus-5@medium`/`xhigh`/`max` 2.2, `opus-5@high` 2.9           |
| **Python**             | **11.8%**         | 5.1–37.5% | `sonnet-5@max` 5.9, `fable-5@medium` 6.6, `sonnet-5@xhigh` 6.6 |

Regression safety is a strong discriminator on Python and a weak one on Go, TypeScript, and React-adjacent work. Across
the whole corpus the riskiest configurations are `luna@low` 27.7%, `luna@medium` 23.5%, `terra@low` 15.4%, and
`terra@medium` 14.7%, which is why those tiers are barred from repository-mutating archetypes.

### Thrash and context exhaustion are eligibility concerns

| config                        | median steps | p90 duration | p90 peak context | timeouts | overflow |
| ----------------------------- | ------------ | ------------ | ---------------- | -------- | -------- |
| `claude-sonnet-5@max`         | 259          | 7,991 s      | 557,026          | 6.0%     | 0.2%     |
| `gemini-3.5-flash@medium`     | 82           | 2,715 s      | **924,506**      | 0.0%     | 3.8%     |
| `gemini-3.1-pro-preview@high` | 77           | 5,004 s      | 817,099          | 0.4%     | 4.4%     |
| `claude-opus-5@medium`        | 43           | 1,464 s      | 136,395          | 0.0%     | 0.0%     |
| `gpt-5.6-sol@high`            | 32           | 932 s        | 150,938          | 0.0%     | 0.0%     |

A large window is not context efficiency. Max-effort OpenAI configurations regularly exceed 70% of a 272K window (Sol
260–290K, Terra 262–309K, Luna 295–352K p90), so the headroom check consumes `p90PeakContextTokens` rather than the task
estimate alone.

### Step frugality is only an independent argument where tokens are not the cost

Claude Opus 4.6 is measurably frugal: 23.6 median API calls against 38.2 for Claude 4.5 Sonnet, 49.8 for Gemini 3 Flash,
and 67.6 for Claude 4.5 Haiku in the SWE-bench Multilingual capture, at 70.8% mean resolve across eight language splits.

That frugality does **not** by itself justify routing to it, because cost per pass already internalizes token efficiency
on any billed route — and on that basis Opus 4.6 is not competitive ($0.970 per resolved instance against $0.492 for
Gemini 3 Flash in the same capture). Frugality becomes an independent advantage in exactly three situations:

1. **Quota-billed surfaces.** GitHub Copilot bills per premium request and seat, not per token, so expected token cost
   carries no signal at all and step count is the only thing left to rank with.
2. **Tight context headroom.** Fewer steps means a lower peak context, which matters when the task estimate already
   consumes most of the window.
3. **Foreground latency.** Fewer round trips shortens a developer loop, which the wall-time term already prices.

The policy therefore keeps Opus 4.6 as a **scoped** candidate rather than a general tier: it is authorized only on a
quota-billed surface or when the estimate exceeds half the window, and it is excluded with a `scope_unmet` reason
otherwise. Its consensus band is 2, two below Claude Opus 5 at high effort, which is why it is not a capability option.
The step term is likewise priced only on quota-constrained surfaces, because pricing it on a billed route would double
count what cost per pass already contains.

### Rank on completion cost, never on token price

`gpt-5.6-terra@low` is the cheapest per pass in the corpus ($1.78) at 24.1% pass, and `gpt-5.6-luna@low` costs $0.07 per
attempt at 1.5% pass. Ranking on completion cost — attempt cost plus the priced human intervention and retry implied by
`1 - passRate` — orders them correctly.

Provider route cost is a separate and smaller matter. `provider_costs` records Claude Opus 5 at $7.42/MTok on the
Anthropic direct route, Bedrock Claude rates observed roughly 10% higher, and a verified ~50% Bedrock/Vertex/Azure
markup for Claude Sonnet 5. That is enough to order routes **for the same model** and not enough to change which model
is chosen.

### Reliability and partial credit are separate axes

`repeatAllPassRate` (same task passed in all repeated trials) separates deterministic configurations
(`claude-opus-5@max` 54.9%, `gpt-5.6-sol@max` 54.0%) from high-variance ones (`gpt-5.6-luna@max` 37.5% with 52.7%
flakiness). `partialCreditOnFailure` separates configurations that leave usable progress (`gpt-5.5@high` 85.1%,
`claude-opus-5@high` 83.0%) from ones that fail hard (`claude-fable-5@max` 64.9%, `claude-sonnet-5@max` 70.0%).
Unattended work weights determinism; attended work can accept good partial progress.

`gpt-5.6-luna@max` is the single best hard-task solver in the corpus (47.1% on `upstart_core`, 44.4% on TypeScript) and
is far too flaky to be a default, so it is authorized only as a hard-task escalation candidate.

## How to refresh this file

1. Re-run `analysis/router_capability_slices.py` in the corpus against a newer DeepSWE snapshot.
2. Regenerate the JSON rows for router-relevant models only, preserving the field names in this schema.
3. Update this document's tables and the dated decision entries in [`decisions.md`](decisions.md).
4. Re-check [`ATTRIBUTION.md`](../../ATTRIBUTION.md) in the same change.

Do not hand-edit individual numbers in the JSON. Every value must be reproducible from a named source.
