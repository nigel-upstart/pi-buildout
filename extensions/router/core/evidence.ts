import { EVIDENCE_PRIOR_ROWS } from "./evidence-data.ts";
import type { EvidenceLanguageBucket, EvidenceLanguagePrior, EvidencePriorRow } from "./evidence-data.ts";

export type { EvidenceLanguageBucket, EvidencePriorRow } from "./evidence-data.ts";
import type { EffortLevel } from "./profiles.ts";

export type AbilityTier = 1 | 2 | 3 | 4;

const EVIDENCE_LANGUAGE_BUCKETS = ["go", "python", "typescript"] as const;

const EFFORT_RANK: Record<EffortLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function effortRank(effort: EffortLevel): number {
  return EFFORT_RANK[effort];
}

export function findEvidencePrior(modelId: string, effort: EffortLevel): EvidencePriorRow | undefined {
  return EVIDENCE_PRIOR_ROWS.find((row) => row.modelId === modelId && row.effort === effort);
}

/**
 * Only a repository whose tracked files resolve to exactly one measured language gets a
 * language-conditional prior. Mixed repositories and unmeasured stacks (Kotlin, Ruby, HCL,
 * Helm/Argo, protobuf, Kafka) intentionally fall back to the corpus-wide prior, because the
 * evidence pack has no rows for them and guessing an affinity would be unfounded.
 */
export function resolveEvidenceLanguage(languageBuckets: readonly string[]): EvidenceLanguageBucket | undefined {
  const measured = EVIDENCE_LANGUAGE_BUCKETS.filter((bucket) => languageBuckets.includes(bucket));
  return measured.length === 1 ? measured[0] : undefined;
}

function evidenceLanguagePrior(
  row: EvidencePriorRow,
  language: EvidenceLanguageBucket | undefined,
): EvidenceLanguagePrior | undefined {
  return language ? row.byLanguage[language] : undefined;
}

/**
 * Ability bands are derived from the cross-source consensus percentile in the evidence pack
 * (`report-data.json` `model_consensus.performance_best`) rather than hand-set per candidate,
 * so a candidate cannot claim a tier its measured evidence does not support.
 */
export function abilityFromConsensus(consensusBest: number): AbilityTier {
  if (consensusBest >= 90) return 4;
  if (consensusBest >= 75) return 3;
  if (consensusBest >= 45) return 2;
  return 1;
}

/**
 * Models the router routes to that have no DeepSWE rollout row. The value is still derived from
 * a named source rather than invented: it is the consensus band for that model in the same
 * `model_consensus` table. Any candidate absent here and absent from the evidence rows must
 * declare its ability explicitly in policy.
 */
const CONSENSUS_ONLY_ABILITY: Readonly<Record<string, AbilityTier>> = {
  // Claude Haiku 4.5 consensus performance_best 36.5 (single source, non-agentic scope).
  "claude-haiku-4-5": 1,
};

export function evidenceAbility(modelId: string, effort: EffortLevel): AbilityTier | undefined {
  const row = findEvidencePrior(modelId, effort);
  if (row?.consensusBest !== undefined) return abilityFromConsensus(row.consensusBest);
  return CONSENSUS_ONLY_ABILITY[modelId];
}

export type EffortPolicy = {
  modelId: string;
  /**
   * Highest effort justified for ordinary archetypes. Above this, measured pass rate is flat or
   * falling while cost and wall time keep rising.
   */
  saturationEffort: EffortLevel;
  saturationReason: string;
  /** Efforts whose measured behavior is worse than a cheaper tier of the same model. */
  excludedEfforts?: readonly EffortLevel[];
  excludedReason?: string;
  /** Minimum effort permitted when the task mutates a repository. */
  agenticMinimumEffort?: EffortLevel;
  agenticMinimumReason?: string;
  /** Hard per-language ceilings that override `saturationEffort`, including for escalation archetypes. */
  languageCeilings?: Readonly<Partial<Record<EvidenceLanguageBucket, EffortLevel>>>;
  languageCeilingReason?: string;
};

/**
 * Effort is not a uniform quality dial. Each entry records a measured curve from the evidence
 * pack; see specs/routing-layer/model-evidence-2026-07-25.md for the tables behind them.
 */
export const EFFORT_POLICIES: readonly EffortPolicy[] = [
  {
    modelId: "claude-opus-5",
    saturationEffort: "high",
    saturationReason: "pass 72.3 high, 72.5 xhigh, 72.8 max for 49% and 93% more cost per pass",
    languageCeilings: { typescript: "high" },
    languageCeilingReason: "on TypeScript pass degrades above high: 64.3 high, 60.7 xhigh, 63.3 max",
  },
  {
    modelId: "gpt-5.6-sol",
    saturationEffort: "high",
    saturationReason: "pass 69.2 high, 70.6 xhigh, 72.3 max; high holds 74% of max quality at 43% of its cost per pass",
  },
  {
    modelId: "gpt-5.6-terra",
    saturationEffort: "max",
    saturationReason: "effort-hungry: pass 53.8 high, 60.2 xhigh, 69.6 max, so only max is top-tier",
    agenticMinimumEffort: "high",
    agenticMinimumReason: "low and medium break previously passing tests at 15.4% and 14.7%",
  },
  {
    modelId: "gpt-5.6-luna",
    saturationEffort: "max",
    saturationReason: "cliffed curve: pass 1.5 low, 11.3 medium, 44.2 high, 56.9 xhigh, 67.2 max",
    agenticMinimumEffort: "max",
    agenticMinimumReason: "low and medium break previously passing tests at 27.7% and 23.5%",
  },
  {
    modelId: "claude-fable-5",
    saturationEffort: "xhigh",
    saturationReason: "pass peaks at xhigh 69.9",
    excludedEfforts: ["max"],
    excludedReason:
      "max is worse than xhigh on pass (67.3 vs 69.9) and partial credit (64.9% vs 79.9%) at $30.74 vs $19.02 per pass",
  },
  {
    modelId: "claude-sonnet-5",
    saturationEffort: "high",
    saturationReason: "pass 48.2 high with 138 median steps",
    excludedEfforts: ["xhigh", "max"],
    excludedReason:
      "step and context thrash: 174 and 259 median steps, p90 peak context 359,866 and 557,026, 6.0% timeouts at max",
  },
  {
    modelId: "gpt-5.5",
    saturationEffort: "xhigh",
    saturationReason: "pass 64.4 high, 67.0 xhigh",
    agenticMinimumEffort: "medium",
    agenticMinimumReason: "low passes 27.0% and breaks previously passing tests at 14.8%",
  },
];

function findEffortPolicy(modelId: string): EffortPolicy | undefined {
  return EFFORT_POLICIES.find((policy) => policy.modelId === modelId);
}

/**
 * Candidates the evidence pack disqualifies outright. These are excluded before scoring so a
 * measured failure mode cannot be reintroduced by a favorable cost term.
 */
const DISQUALIFIED_MODELS: readonly { modelId: string; reason: string }[] = [
  {
    modelId: "gemini-3.1-pro-preview",
    reason: "pass 11.7%, $80.70 per pass, 22.8% regression breakage, 4.4% context overflow",
  },
  {
    modelId: "gemini-3.5-flash",
    reason: "pass 37.4%, $19.64 per pass, p90 peak context 924,506 with 3.8% context overflow",
  },
  {
    modelId: "claude-opus-4-8",
    reason: "superseded by claude-opus-5 at every effort tier; 56.0% pass at max versus 72.3% at opus-5 high",
  },
];

export function disqualificationReason(modelId: string): string | undefined {
  return DISQUALIFIED_MODELS.find((entry) => entry.modelId === modelId)?.reason;
}

export type EffortAuthorization = { authorized: true } | { authorized: false; reason: string };

export type EffortContext = {
  /** Archetypes allowed to exceed a model's saturation tier (escalation and highest-risk work). */
  allowSuperSaturation: boolean;
  mutatesRepository: boolean;
  language?: EvidenceLanguageBucket | undefined;
};

export function authorizeEffort(modelId: string, effort: EffortLevel, context: EffortContext): EffortAuthorization {
  const disqualified = disqualificationReason(modelId);
  if (disqualified) return { authorized: false, reason: `model disqualified by evidence: ${disqualified}` };
  const policy = findEffortPolicy(modelId);
  if (!policy) return { authorized: true };

  if (policy.excludedEfforts?.includes(effort)) {
    return { authorized: false, reason: `${effort} excluded: ${policy.excludedReason ?? "measured regression"}` };
  }
  if (
    context.mutatesRepository &&
    policy.agenticMinimumEffort &&
    effortRank(effort) < effortRank(policy.agenticMinimumEffort)
  ) {
    return {
      authorized: false,
      reason: `${effort} below the agentic minimum ${policy.agenticMinimumEffort}: ${policy.agenticMinimumReason ?? "measured regression risk"}`,
    };
  }
  const language = context.language;
  const languageCeiling = language ? policy.languageCeilings?.[language] : undefined;
  if (language && languageCeiling && effortRank(effort) > effortRank(languageCeiling)) {
    return {
      authorized: false,
      reason: `${effort} exceeds the ${language} ceiling ${languageCeiling}: ${policy.languageCeilingReason ?? "measured language regression"}`,
    };
  }
  if (!context.allowSuperSaturation && effortRank(effort) > effortRank(policy.saturationEffort)) {
    return {
      authorized: false,
      reason: `${effort} exceeds the saturation tier ${policy.saturationEffort}: ${policy.saturationReason}`,
    };
  }
  return { authorized: true };
}

export type EvidenceCostWeights = {
  developerWaitValuePerMs: number;
  humanInterventionCost: number;
  retryCost: number;
  /** Priced only when the task mutates a repository; regression breakage is otherwise not a cost. */
  regressionBreakCost: number;
  /** Priced only for unattended work, where a non-deterministic pass is not usable. */
  nondeterminismCost: number;
};

export type EvidenceScoreContext = {
  language?: EvidenceLanguageBucket | undefined;
  mutatesRepository: boolean;
  unattended: boolean;
  /** Multiplies the wall-time term for foreground developer loops. */
  waitMultiplier: number;
  /**
   * High ambiguity or high complexity work. Selects the hard-task prior, which is where the
   * measured vendor differences are largest: on hard Go tasks claude-opus-5 at high effort solves
   * 71.9% where gpt-5.6-sol at max solves 31.2%, a gap invisible in the corpus-wide averages.
   */
  hardTask: boolean;
};

export type EvidenceScore = {
  score: number;
  components: {
    attemptCost: number;
    developerWaitCost: number;
    humanInterventionCost: number;
    retryCost: number;
    regressionBreakCost: number;
    nondeterminismCost: number;
  };
  passRateUsed: number;
  languageUsed: EvidenceLanguageBucket | undefined;
};

/**
 * Pre-telemetry ranking. This is the same robust cost-to-done shape the telemetry path uses,
 * seeded from measured priors instead of observed samples.
 *
 * `costPerPassUsd * passRate` is exactly the mean cost per attempt for that configuration, so the
 * token term prices one attempt and the intervention/retry terms price failure. Cost therefore
 * enters selection only through expected completion cost, never as a per-token preference.
 */
export function scoreEvidencePrior(
  row: EvidencePriorRow,
  weights: EvidenceCostWeights,
  context: EvidenceScoreContext,
): EvidenceScore {
  const languagePrior = evidenceLanguagePrior(row, context.language);
  const passRate = context.hardTask
    ? (languagePrior?.hardTaskPassRate ?? row.hardTaskPassRate)
    : (languagePrior?.passRate ?? row.passRate);
  const regressionBreakRate = languagePrior?.regressionBreakRate ?? row.regressionBreakRate;
  const components = {
    // costPerPassUsd * corpus passRate is exactly the mean cost of one attempt; the hard-task
    // pass rate changes the failure price, not what an attempt costs to run.
    attemptCost: row.costPerPassUsd * row.passRate,
    developerWaitCost: weights.developerWaitValuePerMs * context.waitMultiplier * row.p90WallTimeSeconds * 1000,
    humanInterventionCost: weights.humanInterventionCost * (1 - passRate),
    retryCost: weights.retryCost * row.repeatFlakyRate,
    regressionBreakCost: context.mutatesRepository ? weights.regressionBreakCost * regressionBreakRate : 0,
    nondeterminismCost: context.unattended ? weights.nondeterminismCost * (1 - row.repeatAllPassRate) : 0,
  };
  return {
    score: Object.values(components).reduce((total, value) => total + value, 0),
    components,
    passRateUsed: passRate,
    languageUsed: languagePrior ? context.language : undefined,
  };
}

/**
 * Hard-task escalation candidate. After a failed attempt on an ambiguous or complex task, the
 * measured evidence favors changing the model prior over raising effort on a saturated incumbent:
 * gpt-5.6-luna at max solves 47.1% of hard tasks corpus-wide and 44.4% on TypeScript, the best in
 * the corpus, while being far too flaky (52.7%) to be any archetype's default.
 */
export const HARD_TASK_ESCALATION = {
  modelId: "gpt-5.6-luna",
  effort: "max",
  reason: "best measured hard-task solver (47.1% corpus-wide, 44.4% TypeScript) despite 52.7% same-task flakiness",
} as const satisfies { modelId: string; effort: EffortLevel; reason: string };
