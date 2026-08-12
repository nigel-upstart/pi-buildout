# Router model and endpoint evidence — review 2026-08-11

This document replaces the hand-maintained 2026-07-25 Markdown narrative. Its companion
[`model-evidence-2026-07-25.json`](model-evidence-2026-07-25.json) remains the machine-readable authority for the
router's bootstrap priors and is unchanged. This review separates two evidence classes that the former document mixed:

1. benchmark and capability observations, reproduced only from the checked-in JSON; and
2. endpoint price and cache observations, reproduced from the installed pi-ai registry, pi-ai cost implementation,
   operator-confirmed contract terms, and cited vendor documentation.

The JSON has no endpoint token-price fields. In particular, it cannot support claims about direct, Bedrock, Vertex, or
Azure list-price markups. The former endpoint-price assertions sourced from an unavailable external corpus were removed
rather than carried forward. `deepswe.costPerPassUsd` and `cursorbench.costPerTaskUsd` remain below because they are
checked-in benchmark outcomes, not endpoint token rates.

## Reproducing the benchmark tables

Run:

```sh
node scripts/generate-model-evidence-tables.mjs
node scripts/generate-model-evidence-tables.mjs --check
```

The generator reads only `rows` and `frugality` from the checked-in JSON and replaces the marked block below. It sorts
by model and semantic effort order. No table cell in the generated block is transcribed in this document.

## Provenance and construct limits

- `deepswe` is the 2026-07-25 DataCurve DeepSWE v1.1 rollout capture: 22,586 `mini-swe-agent` trials over 113 tasks.
  `passRate` is a deterministic verifier outcome, not the router's accepted-rate telemetry.
- `byLanguage` is the same capture grouped by task language plus the `web_ui_proxy` and `upstart_core` slices. The proxy
  contains 14 browser-runtime tasks and is not React, Next.js, RSC, SSR, or Vercel deployment evidence.
- `cursorbench` is the CursorBench 3.2 public leaderboard captured 2026-07-24.
- `consensus` is the normalized cross-source percentile captured into the JSON on 2026-07-25. The checked-in values are
  reproducible as repository inputs; the external normalization corpus is not present here, so this repository cannot
  regenerate that upstream normalization.
- `frugality` is a SWE-bench Multilingual observation. It documents Claude Opus 4.6's scoped-candidate provenance but is
  not consumed by runtime scoring.
- The rows are pre-telemetry ordering priors, not guarantees. Local, task-leased telemetry supersedes them only after
  the policy's maturity and quality gates.
- GitHub Copilot token prices in the upstream benchmark corpus are capability proxies for a flat-rate product. They are
  not endpoint costs and must not enter endpoint cost comparisons.
- Kotlin, Ruby, HCL/Terraform, Kubernetes/Helm/Argo, protobuf, and Kafka lack comparable DeepSWE rows. Deterministic
  gates, not inferred language affinity, remain authoritative for those areas.

## Generated benchmark and capability tables

<!-- BEGIN GENERATED BENCHMARK TABLES -->

### Agentic capability and reliability

| Model                    | Effort   | Trials | Pass  | Hard pass | Regression break | Partial on failure | Repeat all-pass | Repeat flaky |
| ------------------------ | -------- | ------ | ----- | --------- | ---------------- | ------------------ | --------------- | ------------ |
| `claude-fable-5`         | `low`    | 452    | 57.1% | 25.0%     | 4.9%             | 73.9%              | 24.8%           | 56.6%        |
| `claude-fable-5`         | `medium` | 452    | 63.0% | 28.6%     | 3.8%             | 72.5%              | 34.5%           | 48.7%        |
| `claude-fable-5`         | `high`   | 452    | 65.3% | 26.8%     | 4.7%             | 67.7%              | 37.2%           | 49.6%        |
| `claude-fable-5`         | `xhigh`  | 452    | 69.9% | 30.4%     | 4.9%             | 79.9%              | 51.3%           | 37.2%        |
| `claude-fable-5`         | `max`    | 452    | 67.3% | 29.5%     | 6.6%             | 64.9%              | 49.6%           | 34.5%        |
| `claude-opus-4-8`        | `low`    | 452    | 40.7% | 8.0%      | 6.7%             | 81.8%              | 19.5%           | 48.7%        |
| `claude-opus-4-8`        | `medium` | 452    | 48.7% | 16.1%     | 5.8%             | 82.8%              | 23.9%           | 52.2%        |
| `claude-opus-4-8`        | `high`   | 452    | 51.8% | 12.5%     | 8.0%             | 80.2%              | 25.7%           | 52.2%        |
| `claude-opus-4-8`        | `xhigh`  | 452    | 53.8% | 17.0%     | 6.6%             | 74.9%              | 28.3%           | 52.2%        |
| `claude-opus-4-8`        | `max`    | 452    | 56.0% | 15.2%     | 6.0%             | 70.6%              | 31.9%           | 46.0%        |
| `claude-opus-5`          | `low`    | 452    | 57.7% | 27.7%     | 6.7%             | 83.3%              | 31.0%           | 54.0%        |
| `claude-opus-5`          | `medium` | 452    | 68.1% | 33.0%     | 4.5%             | 81.7%              | 48.7%           | 40.7%        |
| `claude-opus-5`          | `high`   | 452    | 72.4% | 38.4%     | 4.9%             | 83.0%              | 50.4%           | 37.2%        |
| `claude-opus-5`          | `xhigh`  | 451    | 72.5% | 38.4%     | 4.7%             | 79.0%              | 51.3%           | 34.5%        |
| `claude-opus-5`          | `max`    | 449    | 72.8% | 38.4%     | 5.2%             | 77.8%              | 54.9%           | 33.6%        |
| `claude-sonnet-5`        | `low`    | 452    | 30.3% | 9.8%      | 8.0%             | 79.1%              | 8.0%            | 49.6%        |
| `claude-sonnet-5`        | `medium` | 452    | 39.6% | 17.0%     | 5.1%             | 80.7%              | 14.2%           | 50.4%        |
| `claude-sonnet-5`        | `high`   | 452    | 48.2% | 19.6%     | 7.1%             | 81.7%              | 22.1%           | 57.5%        |
| `claude-sonnet-5`        | `xhigh`  | 452    | 49.6% | 19.6%     | 6.4%             | 81.0%              | 23.0%           | 52.2%        |
| `claude-sonnet-5`        | `max`    | 452    | 52.6% | 33.0%     | 5.5%             | 70.0%              | 25.7%           | 53.1%        |
| `gemini-3.1-pro-preview` | `high`   | 452    | 11.7% | 4.5%      | 22.8%            | 59.8%              | 1.8%            | 26.6%        |
| `gemini-3.5-flash`       | `medium` | 452    | 37.4% | 11.6%     | 11.5%            | 71.3%              | 11.5%           | 54.9%        |
| `gemini-3.6-flash`       | `high`   | 452    | 48.4% | 17.9%     | 11.3%            | 80.3%              | 22.1%           | 54.0%        |
| `gpt-5.4`                | `xhigh`  | 452    | 51.8% | 21.4%     | 12.4%            | 82.6%              | 24.8%           | 53.1%        |
| `gpt-5.5`                | `low`    | 452    | 27.0% | 6.3%      | 14.8%            | 73.5%              | 8.8%            | 38.9%        |
| `gpt-5.5`                | `medium` | 452    | 54.0% | 24.1%     | 8.0%             | 81.1%              | 28.3%           | 49.6%        |
| `gpt-5.5`                | `high`   | 452    | 64.4% | 30.4%     | 9.5%             | 85.1%              | 37.2%           | 53.1%        |
| `gpt-5.5`                | `xhigh`  | 452    | 67.0% | 29.5%     | 6.0%             | 83.1%              | 43.4%           | 45.1%        |
| `gpt-5.6-luna`           | `low`    | 452    | 1.6%  | 0.0%      | 27.7%            | 36.4%              | 0.0%            | 4.4%         |
| `gpt-5.6-luna`           | `medium` | 452    | 11.3% | 1.8%      | 23.4%            | 64.3%              | 1.8%            | 25.7%        |
| `gpt-5.6-luna`           | `high`   | 452    | 44.3% | 18.8%     | 9.1%             | 81.2%              | 15.9%           | 59.3%        |
| `gpt-5.6-luna`           | `xhigh`  | 452    | 56.9% | 25.9%     | 6.2%             | 83.7%              | 28.3%           | 50.4%        |
| `gpt-5.6-luna`           | `max`    | 448    | 67.2% | 44.6%     | 5.1%             | 83.7%              | 37.5%           | 52.7%        |
| `gpt-5.6-sol`            | `low`    | 452    | 45.4% | 8.9%      | 9.5%             | 81.3%              | 19.5%           | 52.2%        |
| `gpt-5.6-sol`            | `medium` | 452    | 61.1% | 21.4%     | 6.2%             | 82.8%              | 36.3%           | 44.3%        |
| `gpt-5.6-sol`            | `high`   | 452    | 69.3% | 33.9%     | 4.7%             | 82.0%              | 48.7%           | 38.0%        |
| `gpt-5.6-sol`            | `xhigh`  | 452    | 70.6% | 33.9%     | 6.0%             | 82.0%              | 52.2%           | 33.6%        |
| `gpt-5.6-sol`            | `max`    | 452    | 72.4% | 38.4%     | 6.7%             | 80.0%              | 54.0%           | 31.9%        |
| `gpt-5.6-terra`          | `low`    | 449    | 24.1% | 8.0%      | 15.4%            | 70.0%              | 6.2%            | 38.0%        |
| `gpt-5.6-terra`          | `medium` | 450    | 35.1% | 9.9%      | 14.7%            | 73.1%              | 12.4%           | 47.8%        |
| `gpt-5.6-terra`          | `high`   | 452    | 53.8% | 21.4%     | 9.3%             | 82.0%              | 22.1%           | 58.4%        |
| `gpt-5.6-terra`          | `xhigh`  | 452    | 60.2% | 23.2%     | 8.6%             | 81.3%              | 36.3%           | 44.3%        |
| `gpt-5.6-terra`          | `max`    | 451    | 69.6% | 37.5%     | 6.9%             | 83.9%              | 49.6%           | 38.9%        |

### Agentic operations and cost per solved benchmark task

| Model                    | Effort   | Median steps | Median s | p90 s | p90 context | Overflow | Timeout | Routing error | Cost/pass |
| ------------------------ | -------- | ------------ | -------- | ----- | ----------- | -------- | ------- | ------------- | --------- |
| `claude-fable-5`         | `low`    | 28.0         | 393      | 929   | 78,470      | 0.0%     | 0.7%    | 4.2%          | $6.25     |
| `claude-fable-5`         | `medium` | 40.0         | 631      | 1,415 | 116,987     | 0.0%     | 0.2%    | 3.5%          | $9.36     |
| `claude-fable-5`         | `high`   | 48.0         | 878      | 1,769 | 157,736     | 0.0%     | 0.0%    | 4.9%          | $13.25    |
| `claude-fable-5`         | `xhigh`  | 61.5         | 1,232    | 2,371 | 206,553     | 0.0%     | 0.0%    | 0.0%          | $19.02    |
| `claude-fable-5`         | `max`    | 79.0         | 1,876    | 3,111 | 269,878     | 0.0%     | 0.0%    | 3.5%          | $30.74    |
| `claude-opus-4-8`        | `low`    | 47.0         | 517      | 1,155 | 98,925      | 0.0%     | 0.0%    | 0.0%          | $5.63     |
| `claude-opus-4-8`        | `medium` | 60.0         | 729      | 1,393 | 126,503     | 0.0%     | 0.0%    | 0.0%          | $7.08     |
| `claude-opus-4-8`        | `high`   | 67.0         | 888      | 1,693 | 148,042     | 0.0%     | 0.0%    | 0.0%          | $8.27     |
| `claude-opus-4-8`        | `xhigh`  | 89.5         | 1,836    | 3,620 | 226,976     | 0.0%     | 1.8%    | 0.0%          | $14.74    |
| `claude-opus-4-8`        | `max`    | 113.0        | 2,953    | 6,472 | 307,636     | 0.0%     | 6.0%    | 0.0%          | $22.47    |
| `claude-opus-5`          | `low`    | 29.0         | 337      | 933   | 80,867      | 0.0%     | 0.0%    | 0.0%          | $2.90     |
| `claude-opus-5`          | `medium` | 43.0         | 588      | 1,464 | 136,395     | 0.0%     | 0.0%    | 0.0%          | $4.86     |
| `claude-opus-5`          | `high`   | 64.0         | 1,009    | 1,833 | 195,478     | 0.0%     | 0.0%    | 0.0%          | $8.42     |
| `claude-opus-5`          | `xhigh`  | 80.0         | 1,448    | 2,395 | 251,671     | 0.0%     | 0.0%    | 0.0%          | $12.54    |
| `claude-opus-5`          | `max`    | 91.0         | 1,803    | 2,716 | 292,421     | 0.0%     | 0.0%    | 0.0%          | $16.26    |
| `claude-sonnet-5`        | `low`    | 70.0         | 629      | 1,317 | 137,187     | 0.0%     | 0.0%    | 0.0%          | $7.22     |
| `claude-sonnet-5`        | `medium` | 100.5        | 981      | 1,805 | 189,034     | 0.0%     | 0.0%    | 0.0%          | $10.29    |
| `claude-sonnet-5`        | `high`   | 138.0        | 1,539    | 2,882 | 286,022     | 0.0%     | 0.0%    | 0.0%          | $15.36    |
| `claude-sonnet-5`        | `xhigh`  | 174.0        | 2,230    | 3,875 | 359,865     | 0.0%     | 0.0%    | 0.0%          | $24.02    |
| `claude-sonnet-5`        | `max`    | 259.0        | 4,371    | 7,991 | 557,025     | 0.2%     | 6.0%    | 0.0%          | $49.07    |
| `gemini-3.1-pro-preview` | `high`   | 77.0         | 1,163    | 5,004 | 817,098     | 4.4%     | 0.4%    | 0.0%          | $80.70    |
| `gemini-3.5-flash`       | `medium` | 82.0         | 1,461    | 2,715 | 924,506     | 3.8%     | 0.0%    | 0.0%          | $19.64    |
| `gemini-3.6-flash`       | `high`   | 95.5         | 964      | 1,923 | 278,035     | 0.9%     | 1.3%    | 0.0%          | $7.31     |
| `gpt-5.4`                | `xhigh`  | 63.0         | 1,210    | 2,031 | 264,469     | 0.0%     | 0.0%    | 0.0%          | $10.92    |
| `gpt-5.5`                | `low`    | 27.0         | 486      | 961   | 60,176      | 0.0%     | 0.0%    | 0.0%          | $4.45     |
| `gpt-5.5`                | `medium` | 43.0         | 1,133    | 2,248 | 121,582     | 0.0%     | 0.0%    | 0.0%          | $5.09     |
| `gpt-5.5`                | `high`   | 60.0         | 1,881    | 3,264 | 161,665     | 0.0%     | 0.0%    | 0.0%          | $7.92     |
| `gpt-5.5`                | `xhigh`  | 76.5         | 1,588    | 2,568 | 219,152     | 0.0%     | 0.0%    | 0.0%          | $10.78    |
| `gpt-5.6-luna`           | `low`    | 12.0         | 70       | 130   | 22,783      | 0.0%     | 0.0%    | 0.0%          | $4.68     |
| `gpt-5.6-luna`           | `medium` | 22.0         | 152      | 308   | 50,487      | 0.0%     | 0.0%    | 0.0%          | $1.92     |
| `gpt-5.6-luna`           | `high`   | 44.0         | 394      | 765   | 141,595     | 0.0%     | 0.0%    | 0.0%          | $1.76     |
| `gpt-5.6-luna`           | `xhigh`  | 63.0         | 609      | 1,197 | 220,033     | 0.0%     | 0.0%    | 0.0%          | $2.70     |
| `gpt-5.6-luna`           | `max`    | 92.5         | 983      | 1,823 | 323,620     | 0.0%     | 0.0%    | 0.0%          | $4.51     |
| `gpt-5.6-sol`            | `low`    | 21.0         | 211      | 458   | 65,054      | 0.0%     | 0.0%    | 0.0%          | $2.37     |
| `gpt-5.6-sol`            | `medium` | 26.0         | 355      | 732   | 104,459     | 0.0%     | 0.0%    | 0.0%          | $3.05     |
| `gpt-5.6-sol`            | `high`   | 32.0         | 517      | 932   | 150,938     | 0.0%     | 0.0%    | 0.0%          | $5.01     |
| `gpt-5.6-sol`            | `xhigh`  | 39.0         | 695      | 1,295 | 201,252     | 0.0%     | 0.0%    | 0.0%          | $6.67     |
| `gpt-5.6-sol`            | `max`    | 53.0         | 1,012    | 1,739 | 267,865     | 0.0%     | 0.0%    | 0.0%          | $11.57    |
| `gpt-5.6-terra`          | `low`    | 20.0         | 152      | 286   | 49,031      | 0.0%     | 0.0%    | 0.0%          | $1.78     |
| `gpt-5.6-terra`          | `medium` | 24.0         | 194      | 374   | 63,942      | 0.0%     | 0.0%    | 0.0%          | $1.66     |
| `gpt-5.6-terra`          | `high`   | 31.0         | 315      | 591   | 104,217     | 0.0%     | 0.0%    | 0.0%          | $2.11     |
| `gpt-5.6-terra`          | `xhigh`  | 39.0         | 509      | 880   | 168,148     | 0.0%     | 0.0%    | 0.0%          | $3.53     |
| `gpt-5.6-terra`          | `max`    | 71.0         | 928      | 1,484 | 266,934     | 0.0%     | 0.0%    | 0.0%          | $7.10     |

### CursorBench and cross-source consensus

| Model                    | Effort   | Cursor score | Cursor cost/task | Cursor rank | Consensus low | Consensus best | Consensus high | Sources |
| ------------------------ | -------- | ------------ | ---------------- | ----------- | ------------- | -------------- | -------------- | ------- |
| `claude-fable-5`         | `low`    | 62.1%        | $4.46            | 18          | 61.22         | 63.01          | 65.31          | 2       |
| `claude-fable-5`         | `medium` | 65.2%        | $6.80            | 10          | 69.39         | 74.74          | 81.63          | 2       |
| `claude-fable-5`         | `high`   | 66.5%        | $8.77            | 8           | 73.47         | 78.83          | 85.71          | 2       |
| `claude-fable-5`         | `xhigh`  | —            | —                | —           | 89.80         | 91.58          | 93.88          | 2       |
| `claude-fable-5`         | `max`    | 70.5%        | $17.32           | 1           | 79.59         | 90.82          | 100.00         | 3       |
| `claude-opus-4-8`        | `low`    | 53.1%        | $2.02            | 37          | 24.49         | 25.38          | 26.53          | 2       |
| `claude-opus-4-8`        | `medium` | 56.1%        | $2.81            | 31          | 36.73         | 37.18          | 37.76          | 2       |
| `claude-opus-4-8`        | `high`   | 58.0%        | $3.15            | 27          | 41.84         | 44.07          | 46.94          | 2       |
| `claude-opus-4-8`        | `xhigh`  | —            | —                | —           | 51.02         | 53.70          | 57.14          | 2       |
| `claude-opus-4-8`        | `max`    | 62.3%        | $5.77            | 17          | 57.14         | 67.75          | 92.31          | 3       |
| `claude-opus-5`          | `low`    | 62.8%        | $2.55            | 16          | 63.27         | 65.94          | 69.39          | 2       |
| `claude-opus-5`          | `medium` | 64.3%        | $3.29            | 13          | 75.51         | 78.95          | 81.63          | 2       |
| `claude-opus-5`          | `high`   | 66.7%        | $3.91            | 6           | 88.78         | 92.22          | 94.90          | 2       |
| `claude-opus-5`          | `xhigh`  | —            | —                | —           | 95.92         | 97.07          | 97.96          | 2       |
| `claude-opus-5`          | `max`    | 70.0%        | $8.23            | 2           | 97.96         | 99.11          | 100.00         | 2       |
| `claude-sonnet-5`        | `low`    | 47.7%        | $1.30            | 46          | 9.18          | 10.91          | 12.24          | 2       |
| `claude-sonnet-5`        | `medium` | 52.4%        | $2.16            | 39          | 22.45         | 22.45          | 22.45          | 2       |
| `claude-sonnet-5`        | `high`   | 56.9%        | $3.19            | 29          | 32.65         | 37.12          | 42.86          | 2       |
| `claude-sonnet-5`        | `xhigh`  | —            | —                | —           | 38.78         | 45.03          | 53.06          | 2       |
| `claude-sonnet-5`        | `max`    | 61.5%        | $6.45            | 19          | 44.90         | 57.73          | 76.92          | 3       |
| `gemini-3.1-pro-preview` | `high`   | —            | —                | —           | 4.08          | 4.08           | 4.08           | 1       |
| `gemini-3.5-flash`       | `medium` | —            | —                | —           | 20.41         | 20.41          | 20.41          | 1       |
| `gemini-3.6-flash`       | `high`   | 53.5%        | $1.56            | 36          | 28.57         | 35.72          | 65.38          | 3       |
| `gpt-5.4`                | `xhigh`  | —            | —                | —           | 41.84         | 50.86          | 71.15          | 2       |
| `gpt-5.5`                | `low`    | 46.6%        | $0.98            | 49          | 2.04          | 5.48           | 8.16           | 2       |
| `gpt-5.5`                | `medium` | 53.8%        | $1.51            | 35          | 30.61         | 44.39          | 55.10          | 2       |
| `gpt-5.5`                | `high`   | 58.4%        | $2.05            | 25          | 50.00         | 62.05          | 71.43          | 2       |
| `gpt-5.5`                | `xhigh`  | —            | —                | —           | 50.00         | 68.79          | 86.54          | 3       |
| `gpt-5.6-luna`           | `low`    | 37.6%        | $0.16            | 50          | 0.00          | 0.00           | 0.00           | 2       |
| `gpt-5.6-luna`           | `medium` | 47.7%        | $0.39            | 45          | 2.04          | 5.17           | 9.18           | 2       |
| `gpt-5.6-luna`           | `high`   | 56.8%        | $0.82            | 30          | 28.57         | 33.93          | 40.82          | 2       |
| `gpt-5.6-luna`           | `xhigh`  | —            | —                | —           | 44.90         | 52.93          | 59.18          | 2       |
| `gpt-5.6-luna`           | `max`    | 61.1%        | $1.97            | 20          | 61.22         | 70.56          | 77.55          | 3       |
| `gpt-5.6-sol`            | `low`    | 52.6%        | $1.01            | 38          | 24.49         | 27.93          | 30.61          | 2       |
| `gpt-5.6-sol`            | `medium` | 60.0%        | $1.95            | 21          | 59.18         | 63.78          | 67.35          | 2       |
| `gpt-5.6-sol`            | `high`   | 63.5%        | $2.79            | 15          | 72.45         | 79.91          | 85.71          | 2       |
| `gpt-5.6-sol`            | `xhigh`  | —            | —                | —           | 77.55         | 85.59          | 91.84          | 2       |
| `gpt-5.6-sol`            | `max`    | 67.2%        | $5.69            | 5           | 91.84         | 94.08          | 96.15          | 3       |
| `gpt-5.6-terra`          | `low`    | 46.9%        | $0.53            | 48          | 4.08          | 5.23           | 6.12           | 2       |
| `gpt-5.6-terra`          | `medium` | 50.3%        | $0.61            | 42          | 16.33         | 16.33          | 16.33          | 2       |
| `gpt-5.6-terra`          | `high`   | 54.2%        | $0.89            | 34          | 32.65         | 42.98          | 51.02          | 2       |
| `gpt-5.6-terra`          | `xhigh`  | —            | —                | —           | 55.10         | 60.84          | 65.31          | 2       |
| `gpt-5.6-terra`          | `max`    | 64.9%        | $2.89            | 11          | 79.59         | 84.65          | 87.76          | 3       |

### Per-language and stack-proxy slices

| Model                    | Effort   | Bucket         | Pass  | Hard pass | Regression break | Median s |
| ------------------------ | -------- | -------------- | ----- | --------- | ---------------- | -------- |
| `claude-fable-5`         | `low`    | `go`           | 68.4% | 46.9%     | 2.9%             | 376      |
| `claude-fable-5`         | `low`    | `python`       | 55.9% | 34.4%     | 10.3%            | 355      |
| `claude-fable-5`         | `low`    | `typescript`   | 52.1% | 22.2%     | 2.1%             | 403      |
| `claude-fable-5`         | `low`    | `upstart_core` | 58.7% | 28.8%     | 5.1%             | 381      |
| `claude-fable-5`         | `low`    | `web_ui_proxy` | 46.4% | 41.7%     | 0.0%             | 492      |
| `claude-fable-5`         | `medium` | `go`           | 69.8% | 37.5%     | 4.4%             | 624      |
| `claude-fable-5`         | `medium` | `python`       | 64.0% | 37.5%     | 6.6%             | 548      |
| `claude-fable-5`         | `medium` | `typescript`   | 57.1% | 30.6%     | 1.4%             | 685      |
| `claude-fable-5`         | `medium` | `upstart_core` | 63.6% | 31.7%     | 4.1%             | 622      |
| `claude-fable-5`         | `medium` | `web_ui_proxy` | 50.0% | 50.0%     | 1.8%             | 759      |
| `claude-fable-5`         | `high`   | `go`           | 76.5% | 43.8%     | 5.1%             | 938      |
| `claude-fable-5`         | `high`   | `python`       | 68.4% | 31.3%     | 8.1%             | 816      |
| `claude-fable-5`         | `high`   | `typescript`   | 52.9% | 19.4%     | 2.1%             | 956      |
| `claude-fable-5`         | `high`   | `upstart_core` | 65.8% | 24.0%     | 5.1%             | 873      |
| `claude-fable-5`         | `high`   | `web_ui_proxy` | 51.8% | 41.7%     | 1.8%             | 1,018    |
| `claude-fable-5`         | `xhigh`  | `go`           | 71.3% | 31.3%     | 4.4%             | 1,257    |
| `claude-fable-5`         | `xhigh`  | `python`       | 74.3% | 28.1%     | 9.6%             | 1,118    |
| `claude-fable-5`         | `xhigh`  | `typescript`   | 63.6% | 38.9%     | 2.1%             | 1,406    |
| `claude-fable-5`         | `xhigh`  | `upstart_core` | 69.7% | 25.0%     | 5.3%             | 1,214    |
| `claude-fable-5`         | `xhigh`  | `web_ui_proxy` | 60.7% | 58.3%     | 0.0%             | 1,460    |
| `claude-fable-5`         | `max`    | `go`           | 71.3% | 34.4%     | 7.3%             | 1,892    |
| `claude-fable-5`         | `max`    | `python`       | 69.8% | 25.0%     | 9.6%             | 1,702    |
| `claude-fable-5`         | `max`    | `typescript`   | 57.1% | 30.6%     | 5.0%             | 2,071    |
| `claude-fable-5`         | `max`    | `upstart_core` | 66.0% | 21.1%     | 7.3%             | 1,859    |
| `claude-fable-5`         | `max`    | `web_ui_proxy` | 53.6% | 66.7%     | 1.8%             | 2,294    |
| `claude-opus-4-8`        | `low`    | `go`           | 46.3% | 25.0%     | 3.7%             | 485      |
| `claude-opus-4-8`        | `low`    | `python`       | 40.4% | 9.4%      | 11.1%            | 438      |
| `claude-opus-4-8`        | `low`    | `typescript`   | 40.0% | 5.6%      | 5.7%             | 599      |
| `claude-opus-4-8`        | `low`    | `upstart_core` | 42.2% | 11.5%     | 6.8%             | 499      |
| `claude-opus-4-8`        | `low`    | `web_ui_proxy` | 33.9% | 8.3%      | 0.0%             | 700      |
| `claude-opus-4-8`        | `medium` | `go`           | 52.2% | 28.1%     | 5.9%             | 751      |
| `claude-opus-4-8`        | `medium` | `python`       | 49.3% | 28.1%     | 9.6%             | 635      |
| `claude-opus-4-8`        | `medium` | `typescript`   | 47.1% | 11.1%     | 2.9%             | 825      |
| `claude-opus-4-8`        | `medium` | `upstart_core` | 49.5% | 15.4%     | 6.1%             | 714      |
| `claude-opus-4-8`        | `medium` | `web_ui_proxy` | 39.3% | 16.7%     | 0.0%             | 892      |
| `claude-opus-4-8`        | `high`   | `go`           | 58.1% | 40.6%     | 5.1%             | 885      |
| `claude-opus-4-8`        | `high`   | `python`       | 55.9% | 25.0%     | 11.8%            | 754      |
| `claude-opus-4-8`        | `high`   | `typescript`   | 43.6% | 11.1%     | 8.6%             | 1,023    |
| `claude-opus-4-8`        | `high`   | `upstart_core` | 52.4% | 13.5%     | 8.5%             | 876      |
| `claude-opus-4-8`        | `high`   | `web_ui_proxy` | 39.3% | 8.3%      | 1.8%             | 1,076    |
| `claude-opus-4-8`        | `xhigh`  | `go`           | 66.9% | 43.8%     | 5.9%             | 1,781    |
| `claude-opus-4-8`        | `xhigh`  | `python`       | 53.7% | 28.1%     | 9.6%             | 1,692    |
| `claude-opus-4-8`        | `xhigh`  | `typescript`   | 40.7% | 11.1%     | 6.4%             | 2,091    |
| `claude-opus-4-8`        | `xhigh`  | `upstart_core` | 53.6% | 19.2%     | 7.3%             | 1,820    |
| `claude-opus-4-8`        | `xhigh`  | `web_ui_proxy` | 33.9% | 8.3%      | 0.0%             | 2,171    |
| `claude-opus-4-8`        | `max`    | `go`           | 61.8% | 28.1%     | 7.3%             | 2,994    |
| `claude-opus-4-8`        | `max`    | `python`       | 63.2% | 28.1%     | 9.6%             | 2,602    |
| `claude-opus-4-8`        | `max`    | `typescript`   | 45.7% | 11.1%     | 2.9%             | 3,323    |
| `claude-opus-4-8`        | `max`    | `upstart_core` | 56.8% | 18.3%     | 6.6%             | 2,932    |
| `claude-opus-4-8`        | `max`    | `web_ui_proxy` | 35.7% | 33.3%     | 1.8%             | 3,252    |
| `claude-opus-5`          | `low`    | `go`           | 68.4% | 50.0%     | 4.4%             | 336      |
| `claude-opus-5`          | `low`    | `python`       | 54.4% | 31.3%     | 12.5%            | 317      |
| `claude-opus-5`          | `low`    | `typescript`   | 53.6% | 22.2%     | 5.1%             | 351      |
| `claude-opus-5`          | `low`    | `upstart_core` | 58.7% | 28.8%     | 7.3%             | 330      |
| `claude-opus-5`          | `low`    | `web_ui_proxy` | 48.2% | 41.7%     | 0.0%             | 361      |
| `claude-opus-5`          | `medium` | `go`           | 77.9% | 53.1%     | 2.2%             | 580      |
| `claude-opus-5`          | `medium` | `python`       | 68.4% | 53.1%     | 8.2%             | 508      |
| `claude-opus-5`          | `medium` | `typescript`   | 59.3% | 25.0%     | 4.4%             | 698      |
| `claude-opus-5`          | `medium` | `upstart_core` | 68.5% | 33.7%     | 4.9%             | 573      |
| `claude-opus-5`          | `medium` | `web_ui_proxy` | 53.6% | 58.3%     | 0.0%             | 740      |
| `claude-opus-5`          | `high`   | `go`           | 81.6% | 71.9%     | 2.9%             | 1,005    |
| `claude-opus-5`          | `high`   | `python`       | 70.6% | 46.9%     | 11.8%            | 940      |
| `claude-opus-5`          | `high`   | `typescript`   | 64.3% | 30.6%     | 1.5%             | 1,170    |
| `claude-opus-5`          | `high`   | `upstart_core` | 72.1% | 36.5%     | 5.4%             | 1,005    |
| `claude-opus-5`          | `high`   | `web_ui_proxy` | 66.1% | 58.3%     | 0.0%             | 1,361    |
| `claude-opus-5`          | `xhigh`  | `go`           | 85.9% | 62.5%     | 2.2%             | 1,448    |
| `claude-opus-5`          | `xhigh`  | `python`       | 70.6% | 43.8%     | 11.2%            | 1,328    |
| `claude-opus-5`          | `xhigh`  | `typescript`   | 60.7% | 25.0%     | 2.2%             | 1,604    |
| `claude-opus-5`          | `xhigh`  | `upstart_core` | 72.3% | 36.5%     | 5.2%             | 1,448    |
| `claude-opus-5`          | `xhigh`  | `web_ui_proxy` | 55.4% | 41.7%     | 0.0%             | 1,781    |
| `claude-opus-5`          | `max`    | `go`           | 80.6% | 62.5%     | 2.2%             | 1,809    |
| `claude-opus-5`          | `max`    | `python`       | 74.3% | 37.5%     | 11.9%            | 1,669    |
| `claude-opus-5`          | `max`    | `typescript`   | 63.3% | 36.1%     | 2.9%             | 1,877    |
| `claude-opus-5`          | `max`    | `upstart_core` | 72.6% | 39.4%     | 5.7%             | 1,793    |
| `claude-opus-5`          | `max`    | `web_ui_proxy` | 60.7% | 50.0%     | 0.0%             | 2,271    |
| `claude-sonnet-5`        | `low`    | `go`           | 33.8% | 6.3%      | 8.8%             | 624      |
| `claude-sonnet-5`        | `low`    | `python`       | 30.1% | 12.5%     | 8.1%             | 555      |
| `claude-sonnet-5`        | `low`    | `typescript`   | 34.3% | 13.9%     | 8.6%             | 723      |
| `claude-sonnet-5`        | `low`    | `upstart_core` | 32.8% | 14.4%     | 8.5%             | 618      |
| `claude-sonnet-5`        | `low`    | `web_ui_proxy` | 30.4% | 8.3%      | 1.8%             | 829      |
| `claude-sonnet-5`        | `medium` | `go`           | 41.2% | 9.4%      | 5.1%             | 871      |
| `claude-sonnet-5`        | `medium` | `python`       | 36.0% | 15.6%     | 5.1%             | 932      |
| `claude-sonnet-5`        | `medium` | `typescript`   | 45.0% | 27.8%     | 5.7%             | 1,072    |
| `claude-sonnet-5`        | `medium` | `upstart_core` | 40.8% | 21.1%     | 5.3%             | 949      |
| `claude-sonnet-5`        | `medium` | `web_ui_proxy` | 51.8% | 25.0%     | 0.0%             | 1,181    |
| `claude-sonnet-5`        | `high`   | `go`           | 47.1% | 15.6%     | 10.3%            | 1,366    |
| `claude-sonnet-5`        | `high`   | `python`       | 49.3% | 28.1%     | 6.6%             | 1,484    |
| `claude-sonnet-5`        | `high`   | `typescript`   | 51.4% | 27.8%     | 6.4%             | 1,635    |
| `claude-sonnet-5`        | `high`   | `upstart_core` | 49.3% | 24.0%     | 7.8%             | 1,514    |
| `claude-sonnet-5`        | `high`   | `web_ui_proxy` | 48.2% | 8.3%      | 3.6%             | 1,870    |
| `claude-sonnet-5`        | `xhigh`  | `go`           | 47.8% | 21.9%     | 7.3%             | 2,058    |
| `claude-sonnet-5`        | `xhigh`  | `python`       | 55.1% | 46.9%     | 6.6%             | 2,012    |
| `claude-sonnet-5`        | `xhigh`  | `typescript`   | 49.3% | 19.4%     | 6.5%             | 2,482    |
| `claude-sonnet-5`        | `xhigh`  | `upstart_core` | 50.7% | 20.2%     | 6.8%             | 2,188    |
| `claude-sonnet-5`        | `xhigh`  | `web_ui_proxy` | 37.5% | 8.3%      | 3.6%             | 2,713    |
| `claude-sonnet-5`        | `max`    | `go`           | 49.3% | 34.4%     | 6.7%             | 4,357    |
| `claude-sonnet-5`        | `max`    | `python`       | 59.6% | 46.9%     | 5.9%             | 4,008    |
| `claude-sonnet-5`        | `max`    | `typescript`   | 49.3% | 36.1%     | 5.0%             | 4,726    |
| `claude-sonnet-5`        | `max`    | `upstart_core` | 52.7% | 27.9%     | 5.8%             | 4,369    |
| `claude-sonnet-5`        | `max`    | `web_ui_proxy` | 48.2% | 25.0%     | 0.0%             | 4,866    |
| `gemini-3.1-pro-preview` | `high`   | `go`           | 15.4% | 9.4%      | 19.1%            | 1,156    |
| `gemini-3.1-pro-preview` | `high`   | `python`       | 9.6%  | 3.1%      | 37.5%            | 899      |
| `gemini-3.1-pro-preview` | `high`   | `typescript`   | 12.1% | 2.8%      | 14.3%            | 1,417    |
| `gemini-3.1-pro-preview` | `high`   | `upstart_core` | 12.4% | 5.8%      | 23.5%            | 1,148    |
| `gemini-3.1-pro-preview` | `high`   | `web_ui_proxy` | 3.6%  | 0.0%      | 5.4%             | 1,075    |
| `gemini-3.5-flash`       | `medium` | `go`           | 39.7% | 25.0%     | 7.3%             | 1,428    |
| `gemini-3.5-flash`       | `medium` | `python`       | 36.8% | 6.3%      | 17.6%            | 1,167    |
| `gemini-3.5-flash`       | `medium` | `typescript`   | 35.0% | 11.1%     | 9.3%             | 1,695    |
| `gemini-3.5-flash`       | `medium` | `upstart_core` | 37.1% | 13.5%     | 11.4%            | 1,444    |
| `gemini-3.5-flash`       | `medium` | `web_ui_proxy` | 26.8% | 8.3%      | 3.6%             | 1,577    |
| `gemini-3.6-flash`       | `high`   | `go`           | 58.1% | 50.0%     | 9.6%             | 882      |
| `gemini-3.6-flash`       | `high`   | `python`       | 41.2% | 9.4%      | 16.9%            | 872      |
| `gemini-3.6-flash`       | `high`   | `typescript`   | 48.6% | 13.9%     | 7.2%             | 1,072    |
| `gemini-3.6-flash`       | `high`   | `upstart_core` | 49.3% | 22.1%     | 11.2%            | 949      |
| `gemini-3.6-flash`       | `high`   | `web_ui_proxy` | 35.7% | 25.0%     | 1.8%             | 1,064    |
| `gpt-5.4`                | `xhigh`  | `go`           | 63.2% | 34.4%     | 7.3%             | 1,214    |
| `gpt-5.4`                | `xhigh`  | `python`       | 46.3% | 18.8%     | 23.5%            | 1,131    |
| `gpt-5.4`                | `xhigh`  | `typescript`   | 50.0% | 19.4%     | 7.9%             | 1,263    |
| `gpt-5.4`                | `xhigh`  | `upstart_core` | 53.2% | 22.1%     | 12.9%            | 1,208    |
| `gpt-5.4`                | `xhigh`  | `web_ui_proxy` | 37.5% | 16.7%     | 3.6%             | 1,373    |
| `gpt-5.5`                | `low`    | `go`           | 35.3% | 9.4%      | 9.6%             | 530      |
| `gpt-5.5`                | `low`    | `python`       | 25.0% | 12.5%     | 20.6%            | 397      |
| `gpt-5.5`                | `low`    | `typescript`   | 27.1% | 8.3%      | 13.6%            | 534      |
| `gpt-5.5`                | `low`    | `upstart_core` | 29.1% | 10.6%     | 14.6%            | 482      |
| `gpt-5.5`                | `low`    | `web_ui_proxy` | 26.8% | 0.0%      | 5.4%             | 585      |
| `gpt-5.5`                | `medium` | `go`           | 60.3% | 21.9%     | 5.9%             | 1,133    |
| `gpt-5.5`                | `medium` | `python`       | 52.2% | 15.6%     | 11.8%            | 1,003    |
| `gpt-5.5`                | `medium` | `typescript`   | 56.4% | 36.1%     | 5.0%             | 1,345    |
| `gpt-5.5`                | `medium` | `upstart_core` | 56.3% | 23.1%     | 7.5%             | 1,126    |
| `gpt-5.5`                | `medium` | `web_ui_proxy` | 51.8% | 25.0%     | 1.8%             | 1,356    |
| `gpt-5.5`                | `high`   | `go`           | 75.0% | 37.5%     | 5.1%             | 1,822    |
| `gpt-5.5`                | `high`   | `python`       | 61.8% | 21.9%     | 17.6%            | 1,751    |
| `gpt-5.5`                | `high`   | `typescript`   | 60.7% | 36.1%     | 5.0%             | 2,050    |
| `gpt-5.5`                | `high`   | `upstart_core` | 65.8% | 32.7%     | 9.2%             | 1,868    |
| `gpt-5.5`                | `high`   | `web_ui_proxy` | 66.1% | 41.7%     | 0.0%             | 2,037    |
| `gpt-5.5`                | `xhigh`  | `go`           | 75.0% | 31.3%     | 3.7%             | 1,490    |
| `gpt-5.5`                | `xhigh`  | `python`       | 66.9% | 21.9%     | 12.5%            | 1,583    |
| `gpt-5.5`                | `xhigh`  | `typescript`   | 62.1% | 30.6%     | 2.9%             | 1,656    |
| `gpt-5.5`                | `xhigh`  | `upstart_core` | 68.0% | 31.7%     | 6.3%             | 1,584    |
| `gpt-5.5`                | `xhigh`  | `web_ui_proxy` | 48.2% | 33.3%     | 3.6%             | 1,664    |
| `gpt-5.6-luna`           | `low`    | `go`           | 1.5%  | 0.0%      | 19.9%            | 92       |
| `gpt-5.6-luna`           | `low`    | `python`       | 0.0%  | 0.0%      | 36.8%            | 49       |
| `gpt-5.6-luna`           | `low`    | `typescript`   | 3.6%  | 0.0%      | 27.1%            | 70       |
| `gpt-5.6-luna`           | `low`    | `upstart_core` | 1.7%  | 0.0%      | 27.9%            | 68       |
| `gpt-5.6-luna`           | `low`    | `web_ui_proxy` | 3.6%  | 0.0%      | 5.4%             | 66       |
| `gpt-5.6-luna`           | `medium` | `go`           | 15.4% | 6.3%      | 20.6%            | 171      |
| `gpt-5.6-luna`           | `medium` | `python`       | 5.9%  | 3.1%      | 31.6%            | 115      |
| `gpt-5.6-luna`           | `medium` | `typescript`   | 15.7% | 0.0%      | 20.0%            | 174      |
| `gpt-5.6-luna`           | `medium` | `upstart_core` | 12.4% | 1.9%      | 24.0%            | 152      |
| `gpt-5.6-luna`           | `medium` | `web_ui_proxy` | 16.1% | 0.0%      | 3.6%             | 161      |
| `gpt-5.6-luna`           | `high`   | `go`           | 51.5% | 18.8%     | 6.6%             | 394      |
| `gpt-5.6-luna`           | `high`   | `python`       | 42.6% | 15.6%     | 16.2%            | 320      |
| `gpt-5.6-luna`           | `high`   | `typescript`   | 43.6% | 19.4%     | 5.0%             | 457      |
| `gpt-5.6-luna`           | `high`   | `upstart_core` | 45.9% | 19.2%     | 9.2%             | 391      |
| `gpt-5.6-luna`           | `high`   | `web_ui_proxy` | 37.5% | 16.7%     | 1.8%             | 474      |
| `gpt-5.6-luna`           | `xhigh`  | `go`           | 64.7% | 18.8%     | 3.7%             | 637      |
| `gpt-5.6-luna`           | `xhigh`  | `python`       | 61.8% | 31.3%     | 9.6%             | 516      |
| `gpt-5.6-luna`           | `xhigh`  | `typescript`   | 48.6% | 30.6%     | 4.3%             | 702      |
| `gpt-5.6-luna`           | `xhigh`  | `upstart_core` | 58.3% | 26.9%     | 5.8%             | 595      |
| `gpt-5.6-luna`           | `xhigh`  | `web_ui_proxy` | 41.1% | 33.3%     | 0.0%             | 754      |
| `gpt-5.6-luna`           | `max`    | `go`           | 78.7% | 53.1%     | 2.9%             | 914      |
| `gpt-5.6-luna`           | `max`    | `python`       | 65.4% | 25.0%     | 9.6%             | 918      |
| `gpt-5.6-luna`           | `max`    | `typescript`   | 59.6% | 44.4%     | 2.9%             | 1,111    |
| `gpt-5.6-luna`           | `max`    | `upstart_core` | 67.9% | 47.1%     | 5.1%             | 985      |
| `gpt-5.6-luna`           | `max`    | `web_ui_proxy` | 57.1% | 50.0%     | 1.8%             | 1,137    |
| `gpt-5.6-sol`            | `low`    | `go`           | 55.1% | 6.3%      | 5.9%             | 240      |
| `gpt-5.6-sol`            | `low`    | `python`       | 38.2% | 12.5%     | 15.4%            | 176      |
| `gpt-5.6-sol`            | `low`    | `typescript`   | 49.3% | 5.6%      | 7.9%             | 221      |
| `gpt-5.6-sol`            | `low`    | `upstart_core` | 47.6% | 9.6%      | 9.7%             | 209      |
| `gpt-5.6-sol`            | `low`    | `web_ui_proxy` | 41.1% | 8.3%      | 1.8%             | 207      |
| `gpt-5.6-sol`            | `medium` | `go`           | 65.4% | 18.8%     | 2.9%             | 386      |
| `gpt-5.6-sol`            | `medium` | `python`       | 61.0% | 12.5%     | 11.8%            | 290      |
| `gpt-5.6-sol`            | `medium` | `typescript`   | 58.6% | 16.7%     | 3.6%             | 388      |
| `gpt-5.6-sol`            | `medium` | `upstart_core` | 61.7% | 20.2%     | 6.1%             | 353      |
| `gpt-5.6-sol`            | `medium` | `web_ui_proxy` | 55.4% | 16.7%     | 1.8%             | 378      |
| `gpt-5.6-sol`            | `high`   | `go`           | 75.0% | 37.5%     | 3.7%             | 554      |
| `gpt-5.6-sol`            | `high`   | `python`       | 69.1% | 18.8%     | 10.4%            | 432      |
| `gpt-5.6-sol`            | `high`   | `typescript`   | 65.7% | 22.2%     | 1.4%             | 551      |
| `gpt-5.6-sol`            | `high`   | `upstart_core` | 69.9% | 31.7%     | 5.1%             | 515      |
| `gpt-5.6-sol`            | `high`   | `web_ui_proxy` | 67.9% | 16.7%     | 0.0%             | 556      |
| `gpt-5.6-sol`            | `xhigh`  | `go`           | 77.2% | 40.6%     | 3.7%             | 759      |
| `gpt-5.6-sol`            | `xhigh`  | `python`       | 75.0% | 25.0%     | 11.8%            | 636      |
| `gpt-5.6-sol`            | `xhigh`  | `typescript`   | 62.1% | 19.4%     | 2.9%             | 720      |
| `gpt-5.6-sol`            | `xhigh`  | `upstart_core` | 71.4% | 30.8%     | 6.1%             | 690      |
| `gpt-5.6-sol`            | `xhigh`  | `web_ui_proxy` | 60.7% | 33.3%     | 5.5%             | 766      |
| `gpt-5.6-sol`            | `max`    | `go`           | 78.7% | 31.3%     | 5.1%             | 1,068    |
| `gpt-5.6-sol`            | `max`    | `python`       | 74.3% | 28.1%     | 11.2%            | 952      |
| `gpt-5.6-sol`            | `max`    | `typescript`   | 65.7% | 30.6%     | 2.9%             | 1,052    |
| `gpt-5.6-sol`            | `max`    | `upstart_core` | 72.8% | 37.5%     | 6.3%             | 1,010    |
| `gpt-5.6-sol`            | `max`    | `web_ui_proxy` | 67.9% | 41.7%     | 5.4%             | 1,107    |
| `gpt-5.6-terra`          | `low`    | `go`           | 27.9% | 0.0%      | 15.4%            | 175      |
| `gpt-5.6-terra`          | `low`    | `python`       | 24.4% | 19.4%     | 19.3%            | 117      |
| `gpt-5.6-terra`          | `low`    | `typescript`   | 23.0% | 2.8%      | 13.0%            | 186      |
| `gpt-5.6-terra`          | `low`    | `upstart_core` | 25.1% | 9.6%      | 15.8%            | 151      |
| `gpt-5.6-terra`          | `low`    | `web_ui_proxy` | 16.1% | 0.0%      | 5.4%             | 168      |
| `gpt-5.6-terra`          | `medium` | `go`           | 32.4% | 3.1%      | 14.0%            | 214      |
| `gpt-5.6-terra`          | `medium` | `python`       | 34.8% | 3.1%      | 17.8%            | 163      |
| `gpt-5.6-terra`          | `medium` | `typescript`   | 42.1% | 13.9%     | 12.9%            | 229      |
| `gpt-5.6-terra`          | `medium` | `upstart_core` | 36.5% | 12.5%     | 14.8%            | 194      |
| `gpt-5.6-terra`          | `medium` | `web_ui_proxy` | 33.9% | 8.3%      | 5.4%             | 240      |
| `gpt-5.6-terra`          | `high`   | `go`           | 64.7% | 28.1%     | 4.4%             | 320      |
| `gpt-5.6-terra`          | `high`   | `python`       | 46.3% | 9.4%      | 17.6%            | 271      |
| `gpt-5.6-terra`          | `high`   | `typescript`   | 55.7% | 25.0%     | 6.4%             | 374      |
| `gpt-5.6-terra`          | `high`   | `upstart_core` | 55.6% | 26.9%     | 9.5%             | 314      |
| `gpt-5.6-terra`          | `high`   | `web_ui_proxy` | 41.1% | 8.3%      | 1.8%             | 377      |
| `gpt-5.6-terra`          | `xhigh`  | `go`           | 64.7% | 18.8%     | 5.9%             | 517      |
| `gpt-5.6-terra`          | `xhigh`  | `python`       | 55.9% | 12.5%     | 15.4%            | 434      |
| `gpt-5.6-terra`          | `xhigh`  | `typescript`   | 62.1% | 27.8%     | 4.3%             | 559      |
| `gpt-5.6-terra`          | `xhigh`  | `upstart_core` | 60.9% | 26.0%     | 8.5%             | 506      |
| `gpt-5.6-terra`          | `xhigh`  | `web_ui_proxy` | 53.6% | 33.3%     | 0.0%             | 564      |
| `gpt-5.6-terra`          | `max`    | `go`           | 77.2% | 40.6%     | 3.7%             | 898      |
| `gpt-5.6-terra`          | `max`    | `python`       | 68.4% | 25.0%     | 11.8%            | 890      |
| `gpt-5.6-terra`          | `max`    | `typescript`   | 65.5% | 33.3%     | 3.6%             | 975      |
| `gpt-5.6-terra`          | `max`    | `upstart_core` | 70.3% | 39.4%     | 6.3%             | 921      |
| `gpt-5.6-terra`          | `max`    | `web_ui_proxy` | 55.4% | 33.3%     | 5.4%             | 1,090    |

### Step-frugality evidence

Source construct: single-attempt mini-swe-agent resolve rate and median API calls over 300 tasks in 8 language splits.

| Model             | Effort | Median API calls | Resolve rate | Go calls | Python calls | TypeScript calls | Ruby calls |
| ----------------- | ------ | ---------------- | ------------ | -------- | ------------ | ---------------- | ---------- |
| `claude-opus-4-6` | `high` | 23.6             | 70.8%        | 22.0     | —            | 22.0             | 19.5       |

<!-- END GENERATED BENCHMARK TABLES -->

## Audit against the replaced hand-maintained tables

The generator exposed two one-token transcription differences in the outgoing "Thrash and context exhaustion" table:

- `claude-sonnet-5@max` p90 peak context was written as 557,026; the JSON value is **557,025**.
- `gemini-3.1-pro-preview@high` p90 peak context was written as 817,099; the JSON value is **817,098**.

The generated tables use the JSON values. The audit found no other disagreement in the outgoing benchmark table cells.
This is documentation drift only: the JSON and `core/evidence-data.ts` did not change.

## Policy-relevant benchmark findings

The generated rows preserve the policy findings without making the prose another numeric authority:

- Generation currency outranks effort escalation: Claude Opus 5 at high exceeds Claude Opus 4.8 at max on pass rate,
  cost per solved task, regression breakage, and wall time. Opus 5 at low also exceeds Opus 4.8 at max on CursorBench.
- Effort is family-specific. Opus 5 and GPT-5.6 Sol saturate near high; Terra improves through max; Luna cliffs at low
  and medium; Fable max is worse than xhigh on pass rate and partial credit while costing more per pass.
- The strongest language separation is hard Go, where Opus 5 high leads Sol max by about 40 points. Python's main
  discriminator is regression breakage. The TypeScript vendor gap is too small and single-source to justify pass-rate
  substitution.
- Context exhaustion is an eligibility concern. Sonnet 5 max and the retained Gemini rows have very large p90 context
  footprints, and the generated overflow/timeout columns preserve the corresponding failure rates.
- Repeat-all-pass and repeat-flaky are separate from partial credit. Luna max is a strong hard-task escalation row but
  remains too flaky to become a default.
- Opus 4.6 step frugality is independently useful only for quota-billed surfaces, tight context headroom, or foreground
  latency. On token-billed routes, cost per solved task already incorporates token efficiency.
- Ranking uses completion cost rather than token price. Very cheap failed attempts can still be expensive once human
  intervention and retry are included.

## Endpoint price evidence boundary

Endpoint rates are surveyed independently of the benchmark JSON:

```sh
node scripts/survey-endpoint-prices.mjs > /tmp/router-endpoint-price-survey.json
```

The survey is offline and deterministic. For every logical model declared in `MODEL_VENDOR`, it records every matching
registry endpoint, exact and canonical IDs, four token rates, cache/input ratios, price-tier count, supported thinking
levels, and the `0.25 * input + 0.75 * output` blend. A logical model absent from the installed development registry is
still emitted with an empty endpoint list. This matters because the installed development registry can lag the runtime
registry.

The survey is an observation of the installed `@earendil-works/pi-ai` registry, not a contractual source. Published list
rates come from the [Amazon Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/); the private 17% term below
is operator-confirmed and is not claimed to appear on that public page.

### Contract terms and the order-preserving construction

The operator-confirmed Amazon Bedrock discount is **17% off published list price**. It applies to marginal per-token
charges for input, output, `cacheRead`, `cacheWrite`, and the 1-hour cache-write rate. It is not a spend commitment,
credit, or budget-level rebate. The effective scalar is therefore `d = 0.83` for every token class.

For a list-rate vector `p` and any nonnegative usage vector `q`, a parity Bedrock endpoint costs
`q · (0.83p) = 0.83(q · p)`. The same identity gives
`0.25(0.83p_input) + 0.75(0.83p_output) = 0.83(0.25p_input + 0.75p_output)`. Consequently, for model/endpoint pairs
where Bedrock list rates equal first-party list rates—the surveyed bare, `us.`, `global.`, `jp.`, and `au.` parity
profiles—the fixed blend is order-preserving for Bedrock versus first party **by construction, not approximation**. No
token mix and no cache hit rate can reverse that ordering.

The parity condition is essential. Regional or model-specific list-rate exceptions must still use their exact registry
rates: for example, the surveyed `au.anthropic.claude-opus-4-6-v1` is far above first-party list price and remains more
expensive after the 17% discount. The `eu.` Claude profiles also carry proportional markups. A provider-wide scalar must
never replace per-endpoint list rates.

### Cache-rate parity and vendor terms

For every cross-provider Anthropic and OpenAI model in the compared token-billing routes, the registry reports
`cacheRead / input = 0.10` and `cacheWrite / input = 1.25` on `anthropic`, `openai`, `openai-codex`, and all matching
`amazon-bedrock` region profiles. Markups scale proportionally: `eu.anthropic.claude-sonnet-5` is input 2.2, `cacheRead`
0.22, and `cacheWrite` 2.75. The sole-route `amazon-bedrock/openai.gpt-oss-120b` zero/zero entry has no cross-provider
ordering effect.

Vendor documentation agrees on the Claude terms:

- AWS documents 5-minute cache writes at 1.25x input, reads at 0.1x input, a default 5-minute TTL refreshed by cache
  hits, separate `cached_tokens`/`cache_write_tokens` reporting, and cache reads excluded from input-tokens-per-minute
  quotas in [Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
- Anthropic documents the same 1.25x write and 0.1x read rates, the same default 5-minute TTL refreshed at no charge,
  and a 1-hour write at 2x input in
  [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Its model table
  includes the 1-hour option on Bedrock for the Claude families named by this policy.
- AWS documents Bedrock's 1-hour support in the
  [January 2026 announcement](https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching/),
  while the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/) is the published list-rate authority.

Because the contract scalar covers all of these rates, omitting cache terms from the fixed blend does not approximate a
particular cache-hit ratio. It preserves the parity-route ordering for every ratio.

### What a zero cache-write rate means

The installed pi-ai evidence makes the schema semantics explicit:

- `dist/types.d.ts` around lines 255–257 declares `cost.cacheWrite` as a **required number** and `cacheWrite1h` as an
  optional usage field. Across all 1,065 generated registry models, `cacheWrite` is undefined zero times, equals zero
  858 times, and is positive 207 times. No model has a `cacheWrite1h` rate.
- `calculateCost` in `dist/models.js` around lines 186–204 computes
  `cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6`. There is no fallback from a zero
  write rate to `rates.input`. Therefore **zero means no charge, never no premium over base**.
- `cacheRead == 0 && cacheWrite == 0` identifies caching as unpriced or unsupported. `cacheRead > 0 && cacheWrite == 0`
  identifies caching with no separate write line item—the genuine OpenAI, Azure, and Nova shape. For example,
  `azure-openai-responses/gpt-4o` carries input 2.5, `cacheRead` 1.25, and `cacheWrite` 0.
- Rates and reported usage agree. `anthropic-messages.js` populates `usage.cacheWrite` from
  `cache_creation_input_tokens`, and `bedrock-converse-stream.js` uses `cacheWriteInputTokens`. OpenAI-family transports
  do not populate `usage.cacheWrite`, so their zero rate multiplies a zero usage count rather than leaking an input-rate
  charge.

### OpenAI cache-write generations — explicit retraction

**Retraction:** any earlier suggestion that the registry is internally inconsistent about OpenAI cache writes is wrong
and is withdrawn.

The registry is generation-consistent. GPT-5.4 and GPT-5.5 carry `cacheWrite: 0` on every provider. GPT-5.6 Sol carries
`cacheWrite: 6.25`, exactly 1.25x its input rate of 5, on `openai`, `openai-codex`, `azure-openai-responses`,
`amazon-bedrock`, and `opencode`. Its only zero entries are the flat-rate `github-copilot` surface and the
`cloudflare-ai-gateway` gateway. This matches AWS's
[Bedrock prompt-caching documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), which
documents GPT-5.6 as explicit-breakpoint caching with separately billed writes, while GPT-5.5 and earlier use automatic
caching with no write fee.

### One-hour writes

`cacheWrite1h` is a usage split, not a registry rate. Pi-ai's `calculateCost` prices that split as `rates.input * 2`.
Applying a provider weight to the **input rate** therefore discounts 1-hour writes automatically. With the Bedrock
weight `0.83`, the calculated 1-hour write becomes `0.83 * input * 2`, exactly matching the operator-confirmed contract
scope and the vendor-documented 2x list-rate basis.

### Residual OpenAI-rung differences

Bedrock GPT-5.6 uses explicit breakpoints, a 1,024-token minimum, and a 30-minute TTL, as documented by
[AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html). OpenAI direct prompt caching is
automatic; its in-memory entries are generally cleared after about 5–10 minutes of inactivity and always within one
hour, with optional 24-hour retention on eligible non-ZDR configurations, as documented in
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). The direction is ambiguous and
plausibly favors Bedrock for multi-turn agent sessions because an explicit 30-minute window can preserve a prefix across
longer pauses. That is a hit-rate hypothesis, not a price claim, and needs runtime cache-read telemetry.

A separate rate asymmetry remains: direct `openai/gpt-5.6-sol` has a long-context tier above 272,000 input tokens (input
10, output 45, `cacheRead` 1, `cacheWrite` 12.5), while `amazon-bedrock/openai.gpt-5.6-sol` has no corresponding
registry tier. This is not a uniform scalar and must remain a per-endpoint guardrail. Bedrock Sol also lacks the `max`
thinking level, so `max`-effort eligibility excludes it before endpoint ordering.

## Refresh procedure

1. Update the dated JSON only from a named benchmark derivation; do not hand-edit individual values.
2. Update `core/evidence-data.ts` through its data-generation path and keep the JSON agreement test unchanged.
3. Run `node scripts/generate-model-evidence-tables.mjs` and review any diff as a source-data change.
4. Run `node scripts/survey-endpoint-prices.mjs` against the pinned registry and investigate missing logical models,
   changed ratios, thinking levels, and price tiers.
5. Recheck vendor documentation, contract scope, `ATTRIBUTION.md`, and dated decisions in the same change.
