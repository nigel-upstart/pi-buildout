/**
 * Selected exact-effort `model_consensus.performance_best` values from the LLM Effectiveness Report,
 * data through 2026-11-23, normalization 2.2. See ATTRIBUTION.md for the pinned report and sources.
 * These are weighted within-source percentiles, not pass rates, latency, or routing cost priors.
 * Keep the runtime snapshot small: include only pairs whose ability band this refresh uses.
 */
export const NOVEMBER_CONSENSUS_BEST: Readonly<Record<string, number | undefined>> = {
  "claude-haiku-5-5@low": 7.69,
  "claude-haiku-5-5@xhigh": 48.08,
  "gemini-4-neon@high": 98.08,
  "gemini-4-neon@xhigh": 92.89,
  "gpt-6-sol@max": 48.64,
  "gpt-6.1-sol@max": 77.19,
  "gpt-6.1-terra@max": 59.61,
  "gpt-6.2-astra@max": 93.42,
  "gpt-6.2-sol@max": 83.46,
};

/** DeepSWE 5.6 Terra max token totals and report list rates, not 6.1 rollout measurements. */
export const TERRA_MAX_PROXY = {
  sourceModelId: "gpt-5.6-terra",
  sourceRates: { input: 2, cacheRead: 0.2, output: 12 },
  rates: { input: 1, cacheRead: 0.05, output: 5 },
  sourceTokenMix: {
    max: { uncachedInput: 260_839_828, cacheRead: 3_902_142_976, output: 32_444_320 },
  },
};
