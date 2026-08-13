// GENERATED DATA — do not hand-edit individual numbers.
//
// Source of truth: specs/routing-layer/single-attempt-evidence-2026-08-14.json, whose provenance,
// construct limits, and forbidden inferences are documented in
// specs/routing-layer/scoped-model-analysis-2026-08-14.md.
// single-attempt-data.test.mjs asserts this module and that JSON agree, so drift fails the build.
//
// This is a SEPARATE evidence class from evidence-data.ts, and the separation is the point. These rows
// come from single-attempt benchmark submissions, so five of the six terms `scoreEvidencePrior`
// consumes were never measured: regression-break rate, partial credit on failure, repeat-all-pass,
// repeat-flaky, and p90 wall time / p90 peak context. Supplying those fields as zeros or estimates
// would give a single attempt per instance the same weight in cost-to-done ranking as the 452-trial
// DeepSWE rollouts, so instead this module deliberately cannot be scored: no field here shares a name
// with any field `scoreEvidencePrior` reads, and single-attempt-data.test.mjs asserts that.
//
// The field names are chosen for the same reason. `resolveRate` rather than `passRate`, because it is a
// SWE-bench verifier resolve outcome over one attempt and not a repeated-trial pass rate, and the two
// are not interchangeable. `costPerTaskUsd` rather than `costPerPassUsd`, because it is the
// submission's own reported cost per ATTEMPTED task at whatever route it ran on — dividing by the
// resolve rate to obtain a cost per resolved task is a diagnostic the reader may perform, not a router
// input, and it is not a Bedrock rate. The per-language slices carry `costPerResolvedUsd` because that
// is the quantity the upstream per-language derivation publishes.

/** Language splits carried by SWE-bench Multilingual. Not the router's `RoutableLanguage` buckets. */
type SingleAttemptLanguage = "c" | "cpp" | "go" | "java" | "javascript_typescript" | "php" | "ruby" | "rust";

/** One SWE-bench Multilingual language split for one submission. */
type SingleAttemptLanguageSlice = {
  nInstances: number;
  /** Deterministic verifier resolve rate over a single attempt per instance. Not an acceptance rate. */
  resolveRate: number;
  costPerResolvedUsd: number;
  medianApiCalls: number;
};

/** The SWE-bench Verified overall row for one submission. */
type SingleAttemptVerifiedSlice = {
  nInstances: number;
  /** Deterministic verifier resolve rate over a single attempt per instance. Not an acceptance rate. */
  resolveRate: number;
  /** The submission's own reported cost per ATTEMPTED task. Not per resolved task, not a Bedrock rate. */
  costPerTaskUsd: number;
  medianApiCalls: number;
  submission: string;
  date: string;
};

export type SingleAttemptPriorRow = {
  modelId: string;
  /** True when the model is reachable only through an Amazon Bedrock scoped endpoint. */
  scoped: boolean;
  effort: string;
  verified?: SingleAttemptVerifiedSlice;
  byLanguage?: Partial<Record<SingleAttemptLanguage, SingleAttemptLanguageSlice>>;
};

export const SINGLE_ATTEMPT_CAPTURE = "2026-08-14";

export const SINGLE_ATTEMPT_PRIOR_ROWS: readonly SingleAttemptPriorRow[] = [
  {
    modelId: "claude-haiku-4-5",
    scoped: false,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.666,
      costPerTaskUsd: 0.330924,
      medianApiCalls: 66.154,
      submission: "mini-SWE-agent + Claude 4.5 Haiku (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.6333, costPerResolvedUsd: 0.518018, medianApiCalls: 60.0 },
      cpp: { nInstances: 12, resolveRate: 0.6667, costPerResolvedUsd: 0.717267, medianApiCalls: 91.0 },
      go: { nInstances: 42, resolveRate: 0.4762, costPerResolvedUsd: 0.914793, medianApiCalls: 76.0 },
      java: { nInstances: 43, resolveRate: 0.6744, costPerResolvedUsd: 0.620095, medianApiCalls: 61.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.6047,
        costPerResolvedUsd: 0.598536,
        medianApiCalls: 58.0,
      },
      php: { nInstances: 43, resolveRate: 0.7442, costPerResolvedUsd: 0.508658, medianApiCalls: 65.0 },
      ruby: { nInstances: 44, resolveRate: 0.6136, costPerResolvedUsd: 0.592568, medianApiCalls: 63.5 },
      rust: { nInstances: 43, resolveRate: 0.7674, costPerResolvedUsd: 0.428778, medianApiCalls: 66.0 },
    },
  },
  {
    modelId: "claude-opus-4-5",
    scoped: false,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.768,
      costPerTaskUsd: 0.753908,
      medianApiCalls: 32.896,
      submission: "mini-SWE-agent + Claude 4.5 Opus (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.6333, costPerResolvedUsd: 1.281352, medianApiCalls: 24.0 },
      cpp: { nInstances: 12, resolveRate: 0.6667, costPerResolvedUsd: 1.18755, medianApiCalls: 31.5 },
      go: { nInstances: 42, resolveRate: 0.5714, costPerResolvedUsd: 1.737777, medianApiCalls: 28.0 },
      java: { nInstances: 43, resolveRate: 0.7907, costPerResolvedUsd: 1.079011, medianApiCalls: 25.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.7674,
        costPerResolvedUsd: 1.264858,
        medianApiCalls: 26.0,
      },
      php: { nInstances: 43, resolveRate: 0.7209, costPerResolvedUsd: 1.109921, medianApiCalls: 26.0 },
      ruby: { nInstances: 44, resolveRate: 0.6591, costPerResolvedUsd: 0.85391, medianApiCalls: 22.0 },
      rust: { nInstances: 43, resolveRate: 0.7907, costPerResolvedUsd: 1.08575, medianApiCalls: 28.0 },
    },
  },
  {
    modelId: "claude-opus-4-6",
    scoped: false,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.756,
      costPerTaskUsd: 0.551523,
      medianApiCalls: 28.932,
      submission: "mini-SWE-agent + Claude Opus 4.6",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.7333, costPerResolvedUsd: 1.008374, medianApiCalls: 25.0 },
      cpp: { nInstances: 12, resolveRate: 0.5833, costPerResolvedUsd: 1.248451, medianApiCalls: 30.0 },
      go: { nInstances: 42, resolveRate: 0.5476, costPerResolvedUsd: 1.315195, medianApiCalls: 22.0 },
      java: { nInstances: 43, resolveRate: 0.7209, costPerResolvedUsd: 0.921947, medianApiCalls: 21.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.8372,
        costPerResolvedUsd: 0.946667,
        medianApiCalls: 22.0,
      },
      php: { nInstances: 43, resolveRate: 0.7674, costPerResolvedUsd: 0.784547, medianApiCalls: 23.0 },
      ruby: { nInstances: 44, resolveRate: 0.6591, costPerResolvedUsd: 0.756999, medianApiCalls: 19.5 },
      rust: { nInstances: 43, resolveRate: 0.814, costPerResolvedUsd: 0.777596, medianApiCalls: 26.0 },
    },
  },
  {
    modelId: "claude-sonnet-4-5",
    scoped: false,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.714,
      costPerTaskUsd: 0.657896,
      medianApiCalls: 48.3,
      submission: "mini-SWE-agent + Claude 4.5 Sonnet (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.7, costPerResolvedUsd: 0.991383, medianApiCalls: 37.5 },
      cpp: { nInstances: 12, resolveRate: 0.6667, costPerResolvedUsd: 1.155011, medianApiCalls: 37.0 },
      go: { nInstances: 42, resolveRate: 0.5476, costPerResolvedUsd: 1.443979, medianApiCalls: 42.0 },
      java: { nInstances: 43, resolveRate: 0.7442, costPerResolvedUsd: 0.91068, medianApiCalls: 41.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.6512,
        costPerResolvedUsd: 0.999355,
        medianApiCalls: 39.0,
      },
      php: { nInstances: 43, resolveRate: 0.7442, costPerResolvedUsd: 0.836587, medianApiCalls: 34.0 },
      ruby: { nInstances: 44, resolveRate: 0.6136, costPerResolvedUsd: 0.96338, medianApiCalls: 37.5 },
      rust: { nInstances: 43, resolveRate: 0.6977, costPerResolvedUsd: 0.922775, medianApiCalls: 38.0 },
    },
  },
  {
    modelId: "deepseek-v3.2",
    scoped: true,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.7,
      costPerTaskUsd: 0.447846,
      medianApiCalls: 88.506,
      submission: "mini-SWE-agent + DeepSeek V3.2 (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.6, costPerResolvedUsd: 0.846252, medianApiCalls: 81.5 },
      cpp: { nInstances: 12, resolveRate: 0.6667, costPerResolvedUsd: 0.591428, medianApiCalls: 89.5 },
      go: { nInstances: 42, resolveRate: 0.5, costPerResolvedUsd: 0.75147, medianApiCalls: 81.0 },
      java: { nInstances: 43, resolveRate: 0.5814, costPerResolvedUsd: 0.674041, medianApiCalls: 77.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.5814,
        costPerResolvedUsd: 0.755756,
        medianApiCalls: 79.0,
      },
      php: { nInstances: 43, resolveRate: 0.6977, costPerResolvedUsd: 0.471778, medianApiCalls: 77.0 },
      ruby: { nInstances: 44, resolveRate: 0.6364, costPerResolvedUsd: 0.469155, medianApiCalls: 71.5 },
      rust: { nInstances: 43, resolveRate: 0.5116, costPerResolvedUsd: 0.74401, medianApiCalls: 82.0 },
    },
  },
  {
    modelId: "glm-5",
    scoped: true,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.728,
      costPerTaskUsd: 0.534389,
      medianApiCalls: 76.176,
      submission: "mini-SWE-agent + GLM-5 (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.6667, costPerResolvedUsd: 0.999059, medianApiCalls: 63.5 },
      cpp: { nInstances: 12, resolveRate: 0.75, costPerResolvedUsd: 1.084088, medianApiCalls: 61.0 },
      go: { nInstances: 42, resolveRate: 0.5714, costPerResolvedUsd: 1.229428, medianApiCalls: 57.0 },
      java: { nInstances: 43, resolveRate: 0.8605, costPerResolvedUsd: 0.731913, medianApiCalls: 53.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.6512,
        costPerResolvedUsd: 1.064925,
        medianApiCalls: 56.0,
      },
      php: { nInstances: 43, resolveRate: 0.7907, costPerResolvedUsd: 0.722346, medianApiCalls: 47.0 },
      ruby: { nInstances: 44, resolveRate: 0.6364, costPerResolvedUsd: 0.766081, medianApiCalls: 51.5 },
      rust: { nInstances: 43, resolveRate: 0.6744, costPerResolvedUsd: 1.054805, medianApiCalls: 69.0 },
    },
  },
  {
    modelId: "gpt-oss-120b",
    scoped: false,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.26,
      costPerTaskUsd: 0.057119,
      medianApiCalls: 27.598,
      submission: "mini-SWE-agent + gpt-oss-120b",
      date: "2025-08-07",
    },
  },
  {
    modelId: "kimi-k2-thinking",
    scoped: true,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.634,
      costPerTaskUsd: 0.438307,
      medianApiCalls: 46.82,
      submission: "mini-SWE-agent + Kimi K2 Thinking",
      date: "2025-12-10",
    },
  },
  {
    modelId: "kimi-k2.5",
    scoped: true,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.708,
      costPerTaskUsd: 0.146554,
      medianApiCalls: 51.178,
      submission: "mini-SWE-agent + Kimi K2.5 (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.7, costPerResolvedUsd: 1.066133, medianApiCalls: 46.0 },
      cpp: { nInstances: 12, resolveRate: 0.75, costPerResolvedUsd: 1.256797, medianApiCalls: 57.5 },
      go: { nInstances: 42, resolveRate: 0.5952, costPerResolvedUsd: 1.401465, medianApiCalls: 45.5 },
      java: { nInstances: 43, resolveRate: 0.7209, costPerResolvedUsd: 1.076039, medianApiCalls: 44.0 },
      javascript_typescript: {
        nInstances: 43,
        resolveRate: 0.6047,
        costPerResolvedUsd: 1.367665,
        medianApiCalls: 37.0,
      },
      php: { nInstances: 43, resolveRate: 0.6977, costPerResolvedUsd: 0.818178, medianApiCalls: 37.0 },
      ruby: { nInstances: 44, resolveRate: 0.6818, costPerResolvedUsd: 0.605315, medianApiCalls: 32.0 },
      rust: { nInstances: 43, resolveRate: 0.6977, costPerResolvedUsd: 0.91644, medianApiCalls: 45.0 },
    },
  },
  {
    modelId: "minimax-m2.5",
    scoped: true,
    effort: "high",
    verified: {
      nInstances: 500,
      resolveRate: 0.758,
      costPerTaskUsd: 0.07329,
      medianApiCalls: 60.45,
      submission: "mini-SWE-agent + MiniMax M2.5 (high reasoning)",
      date: "2026-02-17",
    },
    byLanguage: {
      c: { nInstances: 30, resolveRate: 0.7333, costPerResolvedUsd: 0.141558, medianApiCalls: 60.5 },
      cpp: { nInstances: 12, resolveRate: 0.6667, costPerResolvedUsd: 0.209711, medianApiCalls: 73.5 },
      go: { nInstances: 42, resolveRate: 0.5952, costPerResolvedUsd: 0.221946, medianApiCalls: 72.0 },
      java: { nInstances: 43, resolveRate: 0.7674, costPerResolvedUsd: 0.128921, medianApiCalls: 59.0 },
      javascript_typescript: { nInstances: 40, resolveRate: 0.7, costPerResolvedUsd: 0.165575, medianApiCalls: 64.5 },
      php: { nInstances: 43, resolveRate: 0.6279, costPerResolvedUsd: 0.159925, medianApiCalls: 60.0 },
      ruby: { nInstances: 44, resolveRate: 0.6591, costPerResolvedUsd: 0.089055, medianApiCalls: 46.5 },
      rust: { nInstances: 42, resolveRate: 0.7381, costPerResolvedUsd: 0.125134, medianApiCalls: 65.0 },
    },
  },
];
