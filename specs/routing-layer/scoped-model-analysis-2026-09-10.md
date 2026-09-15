# Scoped open-weight model reassessment — 2026-09-10

This record applies the current admission gate to the scoped open-weight models visible in pinned
`@earendil-works/pi-ai@0.84.1`. It supplements, rather than rewrites, the historical
[2026-08-13 analysis](scoped-model-analysis-2026-08-13.md).

## Gate and sources

A newly admitted candidate should:

1. land roughly between the available Claude Haiku 4.5 and GPT-5.6 Luna capability anchors;
2. cost no more than three times Luna's direct output-weighted list rate;
3. add a concrete speed, image, context/output, or availability benefit; and
4. remain read-only when its quality evidence is single-attempt.

The capability and speed observations come from the refreshed `llm-effectiveness` report in
[`teamupstart/ai-acceleration` PR #650](https://github.com/teamupstart/ai-acceleration/pull/650) at
`8053ead0ccc38c9bcd84131984d515fdc22bfddd`, with report data through 2026-09-10. SWE-bench Verified rows are
single-attempt mini-SWE-agent submissions over 500 instances and are verifier outcomes, not repeat reliability or human
acceptance. Artificial Analysis uses Intelligence Index v4.3 and cross-provider output speed. A missing value means that
the refreshed report contains no exact row; it is not treated as zero.

Costs come from the pinned registry in USD per million tokens. The comparison is the router's
`0.25 * input + 0.75 * output` blend under the current neutral `1.0` Bedrock preference. Direct Luna is `$0.20` input
and `$1.20` output, for a `$0.95` blend and a three-times ceiling of `$2.85`.

Artificial Analysis records Haiku 4.5 at 15.4 Intelligence Index and 81.09 output tokens/s, and Luna at 37.5 and 119.82
output tokens/s. The latter row is labelled max effort; the report does not expose an effort-matched Artificial Analysis
Luna-medium row, so this is an approximate capability range, not an exact effort comparison.

## Candidate table

| Model            | AA intelligence | SWE Verified resolve | Output tok/s | List blend | × Luna | Endpoint benefit                              | Disposition       |
| ---------------- | --------------: | -------------------: | -----------: | ---------: | -----: | --------------------------------------------- | ----------------- |
| MiniMax M2.5     |               — |                75.8% |            — |     $0.975 |  1.03× | Best retained verifier result; 98K output cap | Retain bounded    |
| Kimi K2.5        |            23.5 |                70.8% |            — |     $2.400 |  2.53× | Image input; strongest retained Ruby slice    | **Admit bounded** |
| Kimi K2 Thinking |            22.0 |                63.4% |       120.98 |     $2.025 |  2.13× | Luna-comparable output speed                  | **Admit bounded** |
| GLM 5            |            27.9 |                72.8% |        71.32 |     $2.650 |  2.79× | 101K output cap                               | Watchlist         |
| GLM 4.7          |            22.2 |                    — |        98.03 |     $1.800 |  1.89× | 131K output cap                               | Exclude           |
| DeepSeek V3.2    |            16.0 |                70.0% |            — |     $1.543 |  1.62× | None over the retained frontier               | Exclude           |
| Qwen3 Coder Next |            10.1 |                    — |       117.12 |     $1.405 |  1.48× | Speed                                         | Exclude           |
| GPT-OSS 120B     |            12.3 |                26.0% |       215.24 |     $0.488 |  0.51× | Lowest price and highest measured speed       | Retain existing   |

## Decisions

- **Kimi K2.5** adds the only image-capable scoped open-weight endpoint in this set and leads the retained Ruby split at
  68.2% resolve. It is admitted behind MiniMax in `fast_classification` and `exact_extraction`.
- **Kimi K2 Thinking** adds measured output speed slightly above Luna and materially above Haiku. It follows K2.5 in the
  same two ladders.
- **GLM 5** passes the numerical capability and price gate, but is the slowest measured candidate and the most expensive
  qualifying open-weight endpoint. It has no image or provider-diversity benefit, and its long output cap does not
  compensate for adding another single-attempt Bedrock fallback to bounded classification. It stays on the watchlist
  rather than being declared structurally eligible. Production acceptance or a schema-fidelity result can change that
  decision.
- **GLM 4.7** lacks an exact repository-success row in the retained capture. Its speed is below Kimi K2 Thinking and its
  intelligence score is effectively tied, so its lower price and larger output cap do not justify another rung.
- **DeepSeek V3.2** is dominated by MiniMax M2.5 on list price, verifier resolve, context window, and output cap.
  **Qwen3 Coder Next** falls below the Haiku intelligence anchor and has no exact retained repository-success row.
- **GPT-OSS 120B** is not a fresh capability admission. Its existing bounded rung remains for its exceptional cost/speed
  point, despite quality below the target range.

All newly admitted Kimi refs carry `singleAttemptEvidence`. Routing refuses them whenever task consequence exceeds
read-only, independent of their ability band. This avoids inventing regression, partial-credit, repeatability,
wall-time-tail, or peak-context values that the source never measured.
