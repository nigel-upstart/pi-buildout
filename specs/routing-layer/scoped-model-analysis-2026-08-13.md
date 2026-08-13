# Scoped Bedrock model analysis — 2026-08-13

This evidence record examines the MiniMax, Kimi, GLM, DeepSeek, Qwen, Nemotron, and Grok models in the pinned pi-ai
registry that are within the router's scoped-model inquiry. It separates endpoint reachability and token-rate evidence
from benchmark quality evidence. The conclusions are bounded to the named versions, providers, harnesses, and source
captures; they are pre-telemetry ordering priors, not acceptance evidence.

The derived analysis originated in the local corpus at `/Users/nigel.stuke/outputs/llm-effectiveness`, with source data
through 2026-08-13. This checked-in record is self-contained: the tables below state the source, construct, population,
and attempt regime needed to interpret each numeric block.

## Reachability audit

The reachability basis is the generated registry in pinned `@earendil-works/pi-ai@0.80.7`, together with the router's
configured provider set and the operator-confirmed absence of OpenRouter. Amazon Bedrock is the only token-billed route
for every scoped model. The token-billed inventory contains 30 scoped endpoints, all with provider `amazon-bedrock`.

The single scoped endpoint outside that token-billed inventory is `github-copilot/kimi-k2.7-code`. It is a flat-rate
subscription surface. [`isFlatRateProvider`](../../extensions/router/core/scope.ts) already excludes it from cost
comparison and orders it last.

OpenRouter, Moonshot, Z.ai, MiniMax, DeepSeek, xAI, Together, Vercel AI Gateway, NVIDIA, and Hugging Face direct routes
are unavailable to this operator. The built-in provider set in
[`core/provider-weights.ts`](../../extensions/router/core/provider-weights.ts) is `amazon-bedrock`, `openai-codex`,
`anthropic`, `google`, `google-vertex`, `bifrost`, and `openai`; [`.env.example`](../../.env.example) configures only
Bifrost. OpenRouter's unavailability is operator-confirmed.

The scoped Bedrock endpoint IDs present are:

- DeepSeek: `deepseek.v3.2`, `deepseek.v3-v1:0`, `deepseek.r1-v1:0`, and `us.deepseek.r1-v1:0`.
- Kimi: `moonshot.kimi-k2-thinking` and `moonshotai.kimi-k2.5`.
- MiniMax: `minimax.minimax-m2`, `minimax.minimax-m2.1`, and `minimax.minimax-m2.5`.
- GLM: `zai.glm-5`, `zai.glm-4.7`, and `zai.glm-4.7-flash`.
- Qwen: `qwen.qwen3-coder-next`, `qwen.qwen3-next-80b-a3b`, `qwen.qwen3-vl-235b-a22b`,
  `qwen.qwen3-coder-480b-a35b-v1:0`, `qwen.qwen3-235b-a22b-2507-v1:0`, `qwen.qwen3-32b-v1:0`, and
  `qwen.qwen3-coder-30b-a3b-v1:0`.
- Nemotron: `nvidia.nemotron-super-3-120b`, `nvidia.nemotron-nano-12b-v2`, `nvidia.nemotron-nano-3-30b`, and
  `nvidia.nemotron-nano-9b-v2`.
- Grok: `xai.grok-4.3`.
- The `openai.gpt-oss-*` family.

Every scoped Bedrock endpoint reports supported thinking levels `off`, `minimal`, `low`, `medium`, and `high`. None
reports `xhigh` or `max`. The available `high` level matches the high-reasoning setting used by the benchmark
submissions below; it does not establish harness equivalence.

## Cost at list and operator-adjusted rates

> **Precision note, 2026-08-13.** The tables in this document were computed at a rounded cache-read share of `0.124` of
> input-side tokens. `referenceMixEndpointCost` in
> [`core/endpoint-cost.ts`](../../extensions/router/core/endpoint-cost.ts) uses the exact share,
> `cacheRead / (input + cacheRead)` = `0.12587`, which reconstructs the observed `10.61%` cache-read share exactly. The
> difference moves cache-priced endpoints down by `0.001` to `0.007` — `gpt-5.6-luna` `0.298` to `0.297`, Haiku 4.5
> `1.233` to `1.232`, `gpt-5.6-terra` `2.977` to `2.974`, Opus 5 `6.167` to `6.161`, `gpt-5.6-sol` `7.442` to `7.435` —
> and leaves every unpriced-cache endpoint unchanged, because those never touch the cache rates. No ordering, break-even
> multiplier or conclusion in this document changes; the tests pin the exact-share values.

The reference token mix is CloudZero authenticated AWS cost data for an observed 30-day Bedrock window: input 73.68%,
output 14.42%, cache read 10.61%, and cache write 1.29%. Where the registry reports `cacheRead = 0` and
`cacheWrite = 0`, this analysis reads caching as unpriced or unsupported and bills all input-side tokens at the input
rate.

**Table basis:** Source: pinned pi-ai registry rates, [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
and CloudZero authenticated AWS cost data. Construct: reference-mix effective dollars per million tokens. n: the
endpoint rows shown; the CloudZero billing-event count is not reported. Attempt status: not applicable; these are
endpoint-rate and observed-mix calculations, not benchmark attempts.

| Endpoint                                   | Cache class                   | List $/MTok | ×0.83 $/MTok |
| ------------------------------------------ | ----------------------------- | ----------- | ------------ |
| `minimax.minimax-m2.5`                     | unpriced                      | 0.430       | 0.357        |
| `moonshotai.kimi-k2.5`                     | unpriced                      | 0.946       | 0.785        |
| `moonshot.kimi-k2-thinking`                | unpriced                      | 0.874       | 0.725        |
| `deepseek.v3.2`                            | unpriced                      | 0.797       | 0.662        |
| `zai.glm-5`                                | unpriced                      | 1.317       | 1.093        |
| `zai.glm-4.7`                              | unpriced                      | 0.831       | 0.689        |
| `zai.glm-4.7-flash`                        | unpriced                      | 0.118       | 0.098        |
| `qwen.qwen3-coder-next`                    | unpriced                      | 0.448       | 0.372        |
| `qwen.qwen3-vl-235b-a22b`                  | unpriced                      | 0.473       | 0.393        |
| `nvidia.nemotron-super-3-120b`             | unpriced                      | 0.222       | 0.184        |
| `xai.grok-4.3`                             | read-only, no write line item | 1.303       | 1.081        |
| `openai.gpt-oss-120b`                      | unpriced                      | 0.215       | 0.178        |
| `anthropic.claude-haiku-4-5-20251001-v1:0` | priced write                  | 1.485       | 1.233        |
| `openai.gpt-5.6-luna`                      | priced write                  | 1.629       | 1.352        |
| `anthropic.claude-sonnet-5`                | priced write                  | 2.969       | 2.464        |
| `openai.gpt-5.6-terra`                     | priced write                  | 4.072       | 3.380        |
| `anthropic.claude-opus-4-8`                | priced write                  | 7.423       | 6.161        |
| `openai.gpt-5.6-sol`                       | priced write                  | 8.144       | 6.759        |

The operator-confirmed adjustment is a uniform scalar `d = 0.83` over every token class. For any nonnegative usage
vector `q` and list-rate vector `p`, a Bedrock endpoint therefore costs `q · (0.83p) = 0.83(q · p)`. Within a
Bedrock-only estate, the scalar changes absolute budget and no cross-model ordering. Its only ordering effect is against
an off-Bedrock incumbent: every break-even multiplier widens by exactly `1 / 0.83 = 1.2048`. Today that boundary applies
to `claude-opus-5`, which is absent from the pinned registry entirely, and every Gemini route, whose `google` and
`google-vertex` weights are `1.0`.

A break-even token multiplier is incumbent effective $/MTok divided by scoped effective $/MTok. It answers how many
times more tokens the scoped model may consume, at equal quality, before it costs the same. This is the same analytical
device that [`core/policy.ts`](../../extensions/router/core/policy.ts) applied to the `gpt-5.4-mini` unmeasured-peer
rung, whose turn break-even was stated as `1.33x`. That rung was withdrawn on 2026-08-13: re-measured against the pinned
registry its price relationship is inverted, so the break-even never favored it. The device is sound; that application
of it rested on a stale rate.

**Table basis:** Source: the preceding reference-mix endpoint-rate construction and configured provider weights.
Construct: equal-quality token-consumption break-even against an Opus-list incumbent, with Bedrock compared at ×0.83 and
Anthropic-direct at weight `1.0`. n: the scoped/incumbent pairs shown. Attempt status: not applicable; this is a
rate-ratio construction, not benchmark trial data.

| Scoped model            | Bedrock Opus-list, both ×0.83 | Anthropic-direct incumbent |
| ----------------------- | ----------------------------- | -------------------------- |
| `minimax-m2.5`          | 17.3x                         | 20.8x                      |
| `qwen3-coder-next`      | 16.6x                         | 20.0x                      |
| `deepseek.v3.2`         | 9.3x                          | 11.2x                      |
| `zai.glm-4.7`           | 8.9x                          | 10.8x                      |
| `kimi-k2-thinking`      | 8.5x                          | 10.2x                      |
| `kimi-k2.5`             | 7.9x                          | 9.5x                       |
| `zai.glm-5`             | 5.6x                          | 6.8x                       |
| `xai.grok-4.3`          | 5.7x                          | 6.9x                       |
| `nemotron-super-3-120b` | 33.5x                         | 40.3x                      |
| `gpt-oss-120b`          | 34.6x                         | 41.6x                      |
| `glm-4.7-flash`         | 63.2x                         | 76.1x                      |

These ratios are price headroom at equal quality, not evidence of equal quality. The quality sections below therefore
use cost per resolved task rather than treating token price as a routing outcome.

## Cache-share sensitivity

The sensitivity construction holds output share at the observed 14.42% and cache-write share at 1.29%, then varies the
cache-read share of input-side tokens. The incumbent is Bedrock Claude Haiku 4.5, with both sides adjusted by ×0.83.

**Table basis:** Source: pinned pi-ai registry rates, AWS Bedrock pricing, and the CloudZero reference mix. Construct:
equal-quality token break-even against Bedrock Claude Haiku 4.5 under varied cache-read share. n: the scoped/incumbent
pairs shown; the CloudZero billing-event count is not reported. Attempt status: not applicable; this is a rate
sensitivity calculation, not benchmark trial data.

| Scoped model                   | cr=12% | cr=30% | cr=50% | cr=70% |
| ------------------------------ | ------ | ------ | ------ | ------ |
| `minimax.minimax-m2.5`         | 3.5    | 3.1    | 2.8    | 2.4    |
| `deepseek.v3.2`                | 1.9    | 1.7    | 1.5    | 1.3    |
| `moonshot.kimi-k2-thinking`    | 1.7    | 1.5    | 1.4    | 1.2    |
| `moonshotai.kimi-k2.5`         | 1.6    | 1.4    | 1.3    | 1.1    |
| `zai.glm-5`                    | 1.1    | 1.0    | 0.9    | 0.8    |
| `qwen.qwen3-coder-next`        | 3.3    | 3.0    | 2.7    | 2.3    |
| `nvidia.nemotron-super-3-120b` | 6.7    | 6.1    | 5.4    | 4.7    |
| `openai.gpt-oss-120b`          | 6.9    | 6.3    | 5.6    | 4.9    |

GLM-5's crossing below `1.0` is disqualifying: under those cache conditions it has no token-consumption headroom over
the incumbent. The router's fixed `0.25 * input + 0.75 * output` blend in
[`core/endpoint-cost.ts`](../../extensions/router/core/endpoint-cost.ts) is cache-blind and cannot represent this
crossing.

The router deliberately holds leases to preserve K/V cache, as reflected by
[`hasSignificantReusableCache`](../../extensions/router/core/lease.ts). Its cache-read share should therefore exceed the
estate-wide 10.61% observation, making the higher sensitivity columns the relevant cases. The router-specific share
remains an open measurement question, not a settled number.

## Quality and cost per resolved task

### Source A: SWE-bench Verified

Source A is [SWE-bench Verified](https://www.swebench.com/) on the mini-SWE-agent harness. It measures verifier-resolved
instances and reported benchmark cost, not human acceptance or pi-harness completion cost.

**Table basis:** Source: SWE-bench Verified. Construct: verifier resolve rate, dollars per attempted task, and dollars
per resolved task under mini-SWE-agent. n: 500 instances. Attempt status: single attempt.

| Model                     | Resolved | $/task | $/resolved |
| ------------------------- | -------- | ------ | ---------- |
| `MiniMax M2.5 (high)`     | 75.8%    | 0.073  | 0.097      |
| `Claude Opus 4.6`         | 75.6%    | 0.552  | 0.730      |
| `GLM-5 (high)`            | 72.8%    | 0.534  | 0.734      |
| `GPT-5.2 Codex`           | 72.8%    | 0.449  | 0.617      |
| `Kimi K2.5 (high)`        | 70.8%    | 0.147  | 0.207      |
| `DeepSeek V3.2 (high)`    | 70.0%    | 0.448  | 0.640      |
| `Claude Haiku 4.5 (high)` | 66.6%    | 0.331  | 0.497      |
| `Kimi K2 Thinking`        | 63.4%    | 0.438  | 0.691      |
| `gpt-oss-120b`            | 26.0%    | 0.057  | 0.220      |

### Source B: SWE-bench Multilingual

Source B is [SWE-bench Multilingual](https://www.swebench.com/) on the mini-SWE-agent harness. The overall rows are
means across the published language splits.

**Table basis:** Source: SWE-bench Multilingual. Construct: mean verifier resolve rate, mean dollars per resolved task,
and mean median API calls under mini-SWE-agent. n: 300 tasks across 8 languages. Attempt status: single attempt.

| Model               | Mean resolve | Mean $/resolved | Mean median API calls |
| ------------------- | ------------ | --------------- | --------------------- |
| `Claude Opus 4.6`   | 70.8%        | 0.970           | 23.6                  |
| `GLM-5`             | 70.0%        | 0.957           | 57.2                  |
| `Claude Opus 4.5`   | 70.0%        | 1.200           | 26.3                  |
| `MiniMax M2.5`      | 68.6%        | 0.155           | 62.6                  |
| `Kimi K2.5`         | 68.1%        | 1.064           | 43.0                  |
| `Claude Sonnet 4.5` | 67.1%        | 1.028           | 38.2                  |
| `Claude Haiku 4.5`  | 64.8%        | 0.612           | 67.6                  |
| `DeepSeek V3.2`     | 59.7%        | 0.663           | 79.8                  |

The same source provides per-language resolve rates for the language slices relevant to this analysis.

**Table basis:** Source: SWE-bench Multilingual. Construct: per-language verifier resolve rate under mini-SWE-agent. n:
Go 42 tasks, Ruby 44 tasks, JavaScript/TypeScript 43 tasks, and Java 43 tasks. Attempt status: single attempt.

| Model               | Go    | Ruby  | JS/TS | Java  |
| ------------------- | ----- | ----- | ----- | ----- |
| `Claude Opus 4.6`   | 54.8% | 65.9% | 83.7% | 72.1% |
| `Claude Opus 4.5`   | 57.1% | 65.9% | 76.7% | 79.1% |
| `GLM-5`             | 57.1% | 63.6% | 65.1% | 86.0% |
| `MiniMax M2.5`      | 59.5% | 65.9% | 70.0% | 76.7% |
| `Kimi K2.5`         | 59.5% | 68.2% | 60.5% | 72.1% |
| `Claude Sonnet 4.5` | 54.8% | 61.4% | 65.1% | 74.4% |
| `Claude Haiku 4.5`  | 47.6% | 61.4% | 60.5% | 67.4% |
| `DeepSeek V3.2`     | 50.0% | 63.6% | 58.1% | 58.1% |

### Findings bounded to the two single-attempt sources

A `6x`–`9x` per-token discount is almost entirely consumed by token inflation. GLM-5 is approximately `8x` cheaper per
token than Opus 4.6 yet is `1.0x` on cost per resolved task: `0.957` against `0.970` in Source B and `0.734` against
`0.730` in Source A. DeepSeek V3.2 is below Claude Haiku 4.5 on Source B mean resolve, `59.7%` against `64.8%`, and has
the worst step inflation at `79.8` calls. These observations confirm the corpus finding to rank on completion cost,
never on token price.

MiniMax M2.5 is the consistent exception in these sources. It is `6.25x` cheaper per resolved task than Opus 4.6 in
Source B and `7.5x` cheaper in Source A. Against Claude Haiku 4.5 in Source B, it has `+3.8` points mean resolve, is
`3.9x` cheaper per resolved task, and uses fewer median calls, `62.6` against `67.6`. Against `gpt-oss-120b` in Source
A, it is `+49.8` points and `2.3x` cheaper per resolved task.

Kimi K2.5 leads the Source B Ruby slice at `68.2%` over 44 tasks. Opus 4.6 and Opus 4.5 are at `65.9%`; Sonnet 4.5 and
Haiku 4.5 are at `61.4%`. Kimi's Ruby result costs `0.605` dollars per resolved task with `32.0` median Ruby calls. The
router's current Ruby policy in [`core/evidence.ts`](../../extensions/router/core/evidence.ts) rests on four
`program_fixer` tasks, so Source B is a materially larger Ruby source.

**Unresolved conflict:** Kimi K2.5's cost per resolved task disagrees across the two splits. It is `3.5x` cheaper than
Opus 4.6 in Source A but `0.91x` in Source B, meaning slightly more expensive. Its cost case is not established. MiniMax
M2.5 is consistent across both splits, which makes its case stronger within this evidence boundary.

GLM-5 leads the Source B Java slice at `86.0%` over 43 tasks. Java was the withdrawn Kotlin proxy. The withdrawal reason
was a cross-generation comparison between Claude 4.6 and GPT-5.2; that reason does not apply in the same way to GLM-5
against Claude 4.5 and 4.6. The Java row does not by itself revive the proxy.

## Reachable-versus-measured disjunction

The strongest current-generation evidence for scoped families comes from multi-trial
[DataCurve DeepSWE v1.1](https://deepswe.datacurve.ai/data/v1.1) rows, but none of the exact versions in that evidence
is reachable on Bedrock.

**Table basis:** Source: DataCurve DeepSWE v1.1. Construct: deterministic verifier pass, hard-task pass,
regression-break, cost per pass, median wall time, timeout, repeat reliability, and peak-context outcomes on
mini-SWE-agent. n: 452 trials over 113 tasks. Attempt status: multi-trial.

| Model/effort             | Pass  | Hard pass | Break | $/pass | Median s | Timeout | Repeat all-pass | Repeat flaky | p90 context |
| ------------------------ | ----- | --------- | ----- | ------ | -------- | ------- | --------------- | ------------ | ----------- |
| `kimi-k3@max`            | 68.4% | 33.9%     | 4.9%  | 6.80   | 3,972    | 2.2%    | 39.8%           | 49.6%        | 201,270     |
| `glm-5-2@max`            | 43.6% | —         | 4.9%  | 8.97   | —        | 7.5%    | —               | —            | —           |
| `glm-5-2@high`           | 36.3% | —         | 10.6% | —      | —        | —       | —               | —            | —           |
| `kimi-k2-7-code` default | 30.5% | —         | 11.3% | —      | —        | —       | —               | —            | —           |
| `grok-4-5@high`          | 53.8% | —         | 6.9%  | 4.49   | 430      | —       | —               | —            | —           |

Kimi K3 also has the corpus's best TypeScript regression-break rate at `0.7%`, plus `78.7%` Go pass and `46.9%` Go
hard-task pass. Its disqualifier is latency and determinism, not quality.

Bedrock instead offers `moonshotai.kimi-k2.5` and `moonshot.kimi-k2-thinking`, not K3; `zai.glm-5` and `zai.glm-4.7`,
not GLM 5.2; and `xai.grok-4.3`, not Grok 4.5 or 4.6. The models with the strongest multi-trial evidence are therefore
unreachable, while the reachable models have only single-attempt evidence anchored against a prior-generation frontier.
[CursorBench](https://cursor.com/evals) carries a training-contamination disclosure for Grok 4.5; Cursor publishes no
equivalent caveat for Grok 4.6.

This disjunction prevents version substitution. A family-name match does not transfer multi-trial quality, reliability,
latency, or cost evidence to the older Bedrock version.

## Bounded quality claim and forbidden inference

Both single-attempt sources anchor their comparisons on Claude 4.5/4.6-era Anthropic rows. Neither source contains
`claude-opus-5`. The best scoped model reaches Claude Opus 4.5/4.6-era parity in the source that measures both; no
source shows any scoped model reaching `claude-opus-5`.

The router policy already disqualifies `claude-opus-4-8` as superseded by `claude-opus-5` and admits `claude-opus-4-6`
only as a narrow `scopedFrugal` candidate. Under the same generation-currency rule, a scoped model at Opus 4.6 parity
cannot become an implementation-archetype default.

The specific misreading this evidence forbids is: “MiniMax M2.5 beats Opus 4.6” means “MiniMax M2.5 approaches Opus 5.”
It does not. The corpus's methodological rule applies: a cross-source check is a check only when both sources carry both
vendors at a comparable generation.

Source B also exposes the step-frugality mechanism. Claude Opus 4.6 is the frugality leader at `23.6` median calls, and
every scoped model measured there is `1.8x`–`3.4x` more step-hungry. That is the mechanism by which the per-token
discount is spent.

## The single-attempt evidence class in the router

The rows above are now carried in the router as a distinct evidence class rather than folded into the existing
cost-to-done priors. The machine-readable capture is
[`single-attempt-evidence-2026-08-13.json`](single-attempt-evidence-2026-08-13.json); the runtime mirror is
[`core/single-attempt-data.ts`](../../extensions/router/core/single-attempt-data.ts), and a test asserts the two agree
value for value, so drift fails the build. The capture holds ten rows: the five scoped models under inquiry plus the
five non-scoped submissions that appear alongside them in the same sources and serve as anchors.

**Why it is a separate class.** [`core/evidence.ts`](../../extensions/router/core/evidence.ts) ranks candidates with
`scoreEvidencePrior`, which reads six terms. A single-attempt submission measures one of them, a verifier outcome, and
cannot measure the other five: regression-break rate, partial credit on failure, repeat-all-pass and repeat-flaky rates,
and the p90 wall-time and p90 peak-context tails. Those five need repeated trials on the same task, and the multi-trial
DeepSWE pack supplies them over 452 trials. Supplying them here as zeros or estimates would let a single attempt per
instance enter the same ranking with the same weight as that pack, which is the specific error this record exists to
prevent. The class is therefore structurally barred from scoring: none of its field names coincides with a field
`scoreEvidencePrior` reads, and a test asserts that absence at runtime rather than only in the type system.

**Field naming follows the construct.** `resolveRate` is used rather than `passRate` because it is a verifier resolve
outcome over a single attempt, not a repeated-trial pass rate. `costPerTaskUsd` is used rather than `costPerPassUsd`
because it is each submission's own reported cost per _attempted_ task at whatever route it ran on; it is not a Bedrock
rate and is not comparable to endpoint pricing without rescaling. Cost per _resolved_ task, quoted in the tables above,
is a diagnostic a reader derives from the pair, not a router input.

**Ability band, and its ceiling.** `abilityFromSingleAttempt` assigns a candidate the highest band among the retained
anchors in the same capture whose Verified resolve rate the candidate meets or exceeds, and then clamps the result at
band 2. The clamp is the recorded consequence of the bounded quality claim above: the anchors are Claude 4.5/4.6-era,
`claude-opus-4-6` is band 2 in the router's own consensus table, and no scoped model in either source is measured
against `claude-opus-5`. The evidence therefore cannot distinguish "reaches the prior-generation frontier" from "reaches
the current frontier", and the generation-currency rule that disqualifies `claude-opus-4-8` and admits `claude-opus-4-6`
only narrowly treats those as different claims. On this rule MiniMax M2.5 reaches band 2 at `75.8%` against the band-2
anchor at `75.6%`; GLM-5, Kimi K2.5, DeepSeek V3.2, and Kimi K2 Thinking all sit below that anchor and reach band 1. A
row with no Verified block receives no band at all, because the language splits alone give nothing to compare against
the anchors.

**The two percentile scales are not the same scale.** This is standing caveat 3 below, restated here because it is the
reason `abilityFromSingleAttempt` exists as its own function instead of routing a percentile through
`abilityFromConsensus`. The cost-bearing SWE-bench Verified population tops out at Claude Opus 4.5, so a high percentile
within it means "near the top of a prior-generation field". `abilityFromConsensus` consumes a multi-source percentile
whose field includes the current frontier, and band 3 there means something that field can express and the Verified
field cannot. Passing one to the other would silently convert a bounded claim into an unbounded one, which is why
GLM-5's high within-source standing must not reach band 3; a test pins that.

**What this class does not do.** It makes no model routable. It adds no entry to any vendor map, bootstrap policy,
prompt profile, or reviewer or classifier tier, and it changes no existing candidate's band: the anchors remain banded
by their consensus source, so `claude-haiku-4-5` and `gpt-oss-120b` stay equal at band 1 despite a `40.6` point resolve
gap in this capture. Nor does it re-open the per-token cost argument withdrawn in the correction below. Its sole
function today is to give a scoped candidate a band derived from a named source, which matters because MiniMax M2.5 has
no `model_consensus` row anywhere in the corpus and no multi-trial rollout row, so this is its only source of one.

## Standing caveats

1. Single-attempt verifier outcomes are not human acceptance. They are ordering priors only.
2. Mini-SWE-agent is not pi's harness. Tool use, context management, stopping behavior, and retry behavior may differ.
3. Within-source percentiles are not comparable across sources with different populations. The cost-bearing SWE-bench
   Verified population tops out at Claude Opus 4.5, so a percentile from it is not on the same scale as the multi-source
   consensus percentile consumed by `abilityFromConsensus`.
4. Bedrock prompt-cache support for these scoped models is unverified. Registry `0/0` is read as unpriced, not as proof
   of cache behavior.
5. Tool-call fidelity through `bedrock-converse-stream` is unverified for these models. `toolCapable` is currently
   inferred from a substring heuristic in `pi-state.ts`, not from a scoped-model tool-call evaluation.
6. The local source-corpus capture, with data through 2026-08-13, is newer than the checked-in
   [`model-evidence-2026-07-25.json`](model-evidence-2026-07-25.json) pack. Its consensus percentiles already differ:
   `claude-opus-5@high` is `90.8` in the newer capture and `92.22` in the checked-in pack.

## Source inventory

- [DataCurve DeepSWE v1.1](https://deepswe.datacurve.ai/data/v1.1): current-generation multi-trial quality, reliability,
  operations, and cost-per-pass evidence.
- [SWE-bench Verified and SWE-bench Multilingual](https://www.swebench.com/): single-attempt resolve, benchmark cost,
  API-call, and language-slice evidence for reachable versions.
- [CursorBench](https://cursor.com/evals): independent evaluation context and the Grok training-contamination
  disclosure.
- [Artificial Analysis](https://artificialanalysis.ai/): capability and list-price context in the local corpus.
- [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/): published Bedrock list-price basis.
- CloudZero authenticated AWS cost data: the observed Bedrock token mix.
- `/Users/nigel.stuke/outputs/llm-effectiveness`: local derivation location for the source capture and comparisons
  transcribed into this record.

## Correction — registry re-pinned to 0.84.1

Everything above the source inventory was captured against a locally installed `@earendil-works/pi-ai@0.80.7`, which was
stale: `package.json` pins **0.84.1**. Re-running the audit against the pinned version leaves the scoped-model findings
intact and changes three things that matter more than they look.

**The scoped figures do not move.** All twelve scoped endpoint costs above reproduce exactly under 0.84.1, and the
scoped models' thinking levels, context windows, and image support are unchanged. The reachability conclusion also
holds: Amazon Bedrock remains the only token-billed route for every scoped model.

**`claude-opus-5` is on Bedrock, so the discount is symmetric.** The record above stated that Opus 5 was absent from the
pinned registry, which was an artifact of the stale install. 0.84.1 carries `us.`, `eu.`, `au.`, `jp.` and `global.`
Bedrock profiles plus the direct route. Bedrock Opus 5 is `6.167` against `7.430` direct, so Bedrock wins by the 17%
contract term, exactly as the parity construction predicts. The open question of whether the incumbent sits off Bedrock
is therefore **resolved in the symmetric direction**: the scalar applies to incumbent and scoped model alike, so it
changes absolute budget and no ordering, and the `1.2048` asymmetry described above does not apply to Opus 5 today.

**The GPT-5.6 rungs were repriced, and that withdraws the scoped cost argument at the cheap end.** Bedrock rates moved:

| Endpoint               | 0.80.7 ×0.83 | 0.84.1 ×0.83 |
| ---------------------- | ------------ | ------------ |
| `openai.gpt-5.6-luna`  | 1.352        | **0.298**    |
| `openai.gpt-5.6-terra` | 3.380        | 2.977        |
| `openai.gpt-5.6-sol`   | 6.759        | **7.442**    |

Break-even token multipliers against the cheap incumbent rungs under 0.84.1, all ×0.83 at the observed mix:

| Scoped                         | ×0.83 | vs Opus 5 | vs Sol | vs Luna | vs Haiku 4.5 |
| ------------------------------ | ----- | --------- | ------ | ------- | ------------ |
| `minimax.minimax-m2.5`         | 0.357 | 17.3      | 20.9   | **0.8** | 3.5          |
| `qwen.qwen3-coder-next`        | 0.372 | 16.6      | 20.0   | **0.8** | 3.3          |
| `moonshotai.kimi-k2.5`         | 0.785 | 7.9       | 9.5    | **0.4** | 1.6          |
| `deepseek.v3.2`                | 0.662 | 9.3       | 11.2   | **0.4** | 1.9          |
| `zai.glm-5`                    | 1.093 | 5.6       | 6.8    | **0.3** | 1.1          |
| `nvidia.nemotron-super-3-120b` | 0.184 | 33.5      | 40.4   | 1.6     | 6.7          |
| `openai.gpt-oss-120b`          | 0.178 | 34.6      | 41.7   | 1.7     | 6.9          |

Every scoped model except Nemotron Super and `gpt-oss-120b` is now **more expensive per effective token than Bedrock
GPT-5.6 Luna**, MiniMax M2.5 included at a break-even of 0.8. Against Claude Haiku 4.5 the scoped advantage survives
unchanged, and against Opus 5 and Sol it is larger than before because Sol became dearer.

The consequence is specific and it is a withdrawal, not a caveat. Any argument that admits a scoped model to the cheap
bounded rungs **on per-token price** is void, because the cheapest rung in those ladders is Luna and no scoped model
undercuts it. What survives is only the cost-per-resolved-task argument, and that argument is not yet made against Luna:
the resolve rates recorded above compare scoped models to Claude 4.5/4.6-era anchors, not to a GPT-5.6 rung. Until a
like-for-like completion-cost comparison against Luna exists, the evidence supports no scoped admission to
`fast_classification` or `exact_extraction`.

Two further observations follow from the same re-pin:

- **Bedrock Sol is no longer a rate-parity endpoint.** It is `5.5/33` against `5/30` direct, a 10% markup, so the
  order-preserving-by-construction argument recorded in [`model-evidence-2026-08-11.md`](model-evidence-2026-08-11.md)
  does not cover the Sol pair under 0.84.1. Bedrock Sol still wins on effective cost, but now as an empirical comparison
  rather than an identity. Bedrock Sol also still lacks the `max` thinking level and still exposes no long-context tier
  above 272,000 input tokens, so both existing guards in [`core/routing.ts`](../../extensions/router/core/routing.ts)
  remain correct and necessary.
- **Sol is now dearer than Opus 5 on Bedrock**, `7.442` against `6.167`, which inverts the usual assumption that the
  Anthropic top tier is the expensive one.
- **Kimi K3 and Grok 4.5 are now reachable, but only on GitHub Copilot.** These are two of the versions the multi-trial
  DeepSWE evidence actually measures. Copilot is flat-rate, so `isFlatRateProvider` excludes both from cost comparison
  and orders them last, and no per-request cost exists for them. The reachable-versus-measured disjunction is therefore
  narrower than stated above but not closed: the measured versions remain unavailable on any token-billed route.

Standing caveat 6 above is unchanged and now has a companion: a locally installed dependency may lag the pinned
manifest, so a registry observation is only as good as the installed tree it was taken from. The figures in this
correction were taken from `@earendil-works/pi-ai@0.84.1` as pinned in `package.json`.
