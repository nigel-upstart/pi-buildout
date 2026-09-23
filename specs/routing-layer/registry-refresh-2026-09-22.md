# Registry refresh to pi 0.85.1 — 2026-09-22

This record reviews the model registry change behind issue #64, which moves the pinned development packages from
`@earendil-works/pi-ai@0.84.1` to `0.85.1`. It adds to the [2026-08-11 evidence](model-evidence-2026-08-11.md), the
[2026-08-13 analysis](scoped-model-analysis-2026-08-13.md), and the
[2026-09-10 reassessment](scoped-model-analysis-2026-09-10.md) without rewriting them. Those records remain accurate for
0.84.1.

At runtime the router reads the registry of the installed pi, not the development packages. Installs already on pi
0.85.1 have been routing on these rates. The bump brings the pinned tests and this evidence in line with them.

## Rate changes that reach router pins

Rates are USD per million tokens (input/output). Effective costs use the router's `0.25 * input + 0.75 * output` blend
and the built-in provider weights.

| Endpoint                                   | 0.84.1 | 0.85.1 | Effective cost, 0.84.1 → 0.85.1 |
| ------------------------------------------ | ------ | ------ | ------------------------------- |
| `openai/gpt-5.6-sol`                       | 5/30   | 4/20   | 23.77375 → 16.016               |
| `amazon-bedrock/openai.gpt-5.6-sol`        | 5.5/33 | 4.4/22 | 26.12526125 → 17.600176         |
| `amazon-bedrock/global.openai.gpt-5.6-sol` | absent | 4/20   | new, 16.00016                   |
| `openai-codex/gpt-5.6-sol`                 | 5/30   | 5/30   | 23.75, unchanged                |
| `azure-openai-responses/gpt-5.6-sol`       | 5/30   | 4/20   | not pinned                      |
| `github-copilot/gpt-5.6-sol`               | 5/30   | 4/20   | flat-rate, not ordered by cost  |

Consequences:

- **Sol endpoint order changes.** Under 0.84.1 the order was Codex, then direct OpenAI, then Bedrock. Under 0.85.1 it is
  Bedrock `global.`, then direct OpenAI, then Bedrock `openai.`, then Codex. Codex kept its 5/30 list rate while the
  direct route dropped to 4/20, so the Codex and direct routes are no longer near parity.
- **Bedrock `openai.gpt-5.6-sol` is still a 10% markup on direct, not a parity pair.** The 2026-08-11 finding still
  holds for that id. The new `global.openai.gpt-5.6-sol` profile is at parity with direct, and the Bedrock preference
  weight (`1.00001` against OpenAI's `1.001`) places it first. Bedrock `openai.` Sol (17.600176) now follows direct
  OpenAI (16.016). The `0.83` contract term that let it win in the 2026-08-13 analysis was removed in
  `router-policy-v8`.
- **Evidence-ranked cross-model ordering does not move.** It uses `costPerPassUsd` from the evidence priors, and the
  evidence generators do not read the registry. `npm run evidence:check` and `npm run single-attempt:check` pass
  unchanged.
- **The reference-mix diagnostic moves for Sol only.** At the recorded mix, Bedrock Sol is now 6.532 instead of 8.958,
  so it is below Opus 5 (7.423). This diagnostic does not order routes. Every other audited Bedrock rate is unchanged,
  and the test now checks the recorded rates against the installed registry, so the next bump fails there if any of them
  move.

## Policy rationale affected

Item 5 of the [decisions record](decisions.md) and the matching comment in
[`core/policy.ts`](../../extensions/router/core/policy.ts) cut `gpt-5.6-sol` at medium from `fast_classification`
because the Opus 5 medium rung behind it is dominant on both ability band (3 against 2) and effective rate (`6.161`
against `7.442`, at the reference mix with the since-removed `0.83` Bedrock weight). Under 0.85.1 and the current
`1.00001` weight, Bedrock Sol at that mix is `6.532` (`5.938` for `global.`) against an unchanged `7.423` for Opus 5.
The ability band still favors Opus 5, but the rate no longer does, so Sol at medium is a cost-for-capability tradeoff
rather than a dominated rung. This record does not reinstate it. That is a policy decision, and the `policy.ts` comment
now says the cut rests on the ability band alone. The decision is tracked in
[#67](https://github.com/nigel-upstart/pi-buildout/issues/67).

## Context windows and the long-context pricing guard

Pi 0.85.1 raises the Bedrock context window for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` from 272,000 to
1,050,000 tokens, including the new `global.` profiles. None of them gains a price tier. The direct OpenAI and Codex
routes keep a 272,000 context window with a tier above 272,000 tokens.

Under 0.84.1 the router's 70% context headroom rule kept these Bedrock endpoints out of requests above about 190,000
tokens. Under 0.85.1 they would qualify up to about 735,000 tokens, priced at a short-context rate that the registry
does not claim beyond 272,000. The router already excluded Bedrock Sol above 272,000 estimated tokens for this reason.

**Change:** `bedrockLongContextPricingUnavailable` in [`core/routing.ts`](../../extensions/router/core/routing.ts) now
applies the same 272,000-token boundary to Bedrock Terra and Luna, in both route selection and lease revalidation. For
Terra and Luna this keeps large-request behavior close to what 0.84.1 produced. The exclusion detail names the model.

The Sol effort guard is unchanged and still necessary: Bedrock Sol still exposes `xhigh` and no `max` thinking level.

## Cache-write observations

- **Cloudflare Sol.** Under 0.84.1, `cloudflare-ai-gateway/gpt-5.6-sol` listed no cache-write rate and was the one Sol
  exception in the price survey. 0.85.1 prices a write at 1.5625 times input, with cache read at 0.125 times input.
  Every billed Sol route carries 1.25 and 0.1. The tests pin the observed value; this record does not claim that
  Cloudflare bills at that ratio.
- **Copilot Luna and Terra** now list priced cache writes (0.25 and 2.5).
- **Cloudflare `gpt-5.5`** drops its cache-read rate to 0, so it classifies as `caching_unpriced`.
- `gpt-5.4` and `gpt-5.5` still list `cacheWrite: 0` on every billed route. Every billed Sol route still carries the
  1.25 write multiplier.

## Gateway Sol rates

`opencode`, `openrouter`, `vercel-ai-gateway`, and `cloudflare-ai-gateway` list `gpt-5.6-sol` at 2/10, half of OpenAI's
direct rate. The unknown-provider weight (`1.01`) does not offset that gap. If a scope admits one of these gateways, it
would lead the Sol endpoint order. These rates have not been checked against gateway billing. No routing change is made
for them. Verification is tracked in [#68](https://github.com/nigel-upstart/pi-buildout/issues/68).

## Unchanged

- Scoped open-weight Bedrock rates (MiniMax, Kimi, DeepSeek, GLM, gpt-oss) and the 2026-09-10 admission decisions.
- Direct Luna at 0.20/1.20, so the three-times admission ceiling stays at 2.85.
- Claude Sonnet 5 and Opus 5 rates on every compared route, including regional Bedrock markups.

## Newly declared models

0.85.1 declares two models that the router policy already names:

- **`gemini-3.8-flash`** is now in the pinned registry on `google` and `google-vertex` (0.75/3.75, context 1,048,576).
  It is admitted only to tracked review (decision 2 of the 2026-09-10 section in [`decisions.md`](decisions.md)), and
  runtimes that already exposed it were routing it there. That admission is unchanged.
- **`gpt-6-astra`** is now in the pinned registry on `openai` and `openai-codex` (10/50, with a tier above 272,000 input
  tokens). Decision 6 of the same section kept Astra unrouted, citing a single benchmark source, zero peak-context
  telemetry, and its absence from the pinned registry. Only the last of those reasons is resolved, so Astra stays
  unrouted.

The router policy does not name the other added entries: `claude-fable-5-1` (Anthropic and Bedrock), `xai.grok-4.6` on
Bedrock, and `gemini-3.7-flash` (Google and Vertex). The router does not route to logical models outside its policy, so
this record does not evaluate them.
