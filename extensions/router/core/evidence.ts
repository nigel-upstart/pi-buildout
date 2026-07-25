import { EVIDENCE_PRIOR_ROWS } from "./evidence-data.ts";
import type { EvidenceLanguagePrior, EvidencePriorRow } from "./evidence-data.ts";

export type { EvidencePriorRow } from "./evidence-data.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export type AbilityTier = 1 | 2 | 3 | 4;

const EVIDENCE_LANGUAGE_BUCKETS = ["go", "python", "typescript", "ruby", "kotlin"] as const;

/** Language bucket that the router recognizes, whether or not the corpus measures it. */
export type RoutableLanguage = (typeof EVIDENCE_LANGUAGE_BUCKETS)[number];

export type LanguageEvidencePolicy = {
  language: RoutableLanguage;
  /**
   * Whether the language's own measured pass rate may replace the corpus-wide pass rate in scoring.
   * Authorized only where the within-language vendor gap is large enough to survive the source's
   * power, and where no cross-source disagreement is outstanding.
   */
  passRateSubstitution: boolean;
  /**
   * Weak directional prior used only to break a near-tie between otherwise equivalent candidates.
   * It cannot move a candidate past a materially better score.
   */
  vendorTendency?: ModelVendor;
  confidence: "measured" | "low_power" | "none";
  /**
   * How close two candidates must be, as a fraction of the better score, before `vendorTendency` may
   * reorder them. Sized per language from the strength of that language's evidence rather than as a
   * global knob, because a single global value lands on a knife edge for some languages.
   */
  nearTieFraction?: number;
  reason: string;
};

/**
 * Per-language evidence policy. Each entry records why the language is or is not allowed to change
 * scoring, so a weakly evidenced affinity cannot quietly acquire the weight of a measured one. See
 * specs/routing-layer/model-evidence-2026-07-25.md for the underlying tables and their sources.
 */
export const LANGUAGE_EVIDENCE: readonly LanguageEvidencePolicy[] = [
  {
    language: "go",
    passRateSubstitution: true,
    vendorTendency: "anthropic",
    confidence: "measured",
    reason:
      "34 DeepSWE tasks with a 6.6 point vendor gap at high effort (claude-opus-5 81.6 versus gpt-5.6-sol 75.0) and a 40 point hard-task gap (71.9 versus 31.2); SWE-bench Multilingual independently ranks Go the hardest of eight languages at 54.8% mean resolve",
  },
  {
    language: "python",
    passRateSubstitution: true,
    confidence: "measured",
    reason:
      "34 DeepSWE tasks; vendor-neutral on pass rate (gpt-5.6-sol xhigh 75.0 versus claude-opus-5 max 74.3) but carries the corpus's highest regression breakage at a 11.8% median, which is the axis that matters here",
  },
  {
    language: "typescript",
    passRateSubstitution: false,
    confidence: "measured",
    reason:
      "35 DeepSWE tasks, but the vendor gap is only 1.4 points (gpt-5.6-sol high 65.7 versus claude-opus-5 high 64.3) and is single-source, so the quality claim is held at low confidence pending local telemetry; gpt-5.6-sol still leads TypeScript work on the uncontested latency and cost basis (551 s versus 1170 s median)",
  },
  {
    language: "ruby",
    passRateSubstitution: false,
    vendorTendency: "anthropic",
    confidence: "low_power",
    // Widened from the 0.05 default because the Ruby signal is a floor gap rather than a mean gap:
    // 74-77% worst-task against 57.1%, which is a 24 point spread on the metric that decides whether a
    // single task fails outright. The measured mean-score gap between the leading candidates on routine
    // work is 4.7-5.5% depending on verification strength, so a 0.05 band would fire inconsistently.
    nearTieFraction: 0.08,
    reason:
      "only four current-generation single-file repair tasks exist (llm-benchmarks program_fixer): claude-opus-5 leads at 79.1-80.9% with a 74-77% worst-task floor against gpt-5.6-sol at 74.2% with a 57.1% floor. That is a Minitest pass ratio rather than a verifier resolve rate, so it may not substitute for a pass rate and is used only as a near-tie preference",
  },
  {
    language: "kotlin",
    passRateSubstitution: false,
    confidence: "none",
    reason:
      "no Kotlin evidence in any retained source. The SWE-bench Multilingual Java proxy was withdrawn because its apparent vendor gap rested on GPT-5.2-era rows that the generation-currency rule excludes, making it a cross-generation comparison rather than a cross-vendor one",
  },
];

export function languageEvidence(language: RoutableLanguage | undefined): LanguageEvidencePolicy | undefined {
  return language ? LANGUAGE_EVIDENCE.find((entry) => entry.language === language) : undefined;
}

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
 * Only a repository whose tracked files resolve to exactly one recognized language gets a
 * language-conditional prior. Mixed repositories and languages absent from the table (HCL, Helm and
 * Argo manifests, protobuf, Kafka topologies) intentionally fall back to the corpus-wide prior,
 * because no retained source measures them and guessing an affinity would be unfounded. A recognized
 * language still gets nothing unless its LANGUAGE_EVIDENCE entry authorizes it.
 */
export function resolveEvidenceLanguage(languageBuckets: readonly string[]): RoutableLanguage | undefined {
  const recognized = EVIDENCE_LANGUAGE_BUCKETS.filter((bucket) => languageBuckets.includes(bucket));
  return recognized.length === 1 ? recognized[0] : undefined;
}

function evidenceLanguagePrior(
  row: EvidencePriorRow,
  language: RoutableLanguage | undefined,
): EvidenceLanguagePrior | undefined {
  // Only the DeepSWE-measured buckets carry per-language rollout rows. Ruby and Kotlin are recognized
  // for routing purposes but have no comparable data, so they never produce a language prior.
  switch (language) {
    case "go":
    case "python":
    case "typescript":
      return row.byLanguage[language];
    default:
      return undefined;
  }
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
  // Claude Opus 4.6 consensus performance_best 57.7. Retained as the scoped frugal candidate rather
  // than as a general tier; it is two bands below claude-opus-5 at high effort.
  "claude-opus-4-6": 2,
  // gpt-oss-120b consensus performance_best 36.5 with the corpus's top cost-efficiency percentile.
  // Reachable only on Amazon Bedrock, and it has no agentic rollout evidence at all.
  "gpt-oss-120b": 1,
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
  languageCeilings?: Readonly<Partial<Record<RoutableLanguage, EffortLevel>>>;
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
    // The regression cliff is below high, not below max: breakage falls from 23.5% at medium to 9.1%
    // at high, which is comparable to gpt-5.6-terra at high (9.3%) and is permitted on the same basis.
    agenticMinimumEffort: "high",
    agenticMinimumReason:
      "low and medium break previously passing tests at 27.7% and 23.5%; high measures 9.1% and is permitted",
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

/**
 * What a bad result costs, which is the axis that should gate minimum capability. It is derived from
 * the task's own action mode and risk rather than from its archetype label, because the archetype says
 * what kind of work it is and not how much damage a wrong answer does. A read-only classification and
 * an irreversible release step can share an archetype.
 */
const CONSEQUENCE_TIERS = ["read_only", "reversible", "irreversible"] as const;
export type ConsequenceTier = (typeof CONSEQUENCE_TIERS)[number];

export function consequenceRank(tier: ConsequenceTier): number {
  return CONSEQUENCE_TIERS.indexOf(tier);
}

export type EffortContext = {
  /** Archetypes allowed to exceed a model's saturation tier (escalation and highest-risk work). */
  allowSuperSaturation: boolean;
  consequence: ConsequenceTier;
  language?: RoutableLanguage | undefined;
};

/**
 * Minimum ability band per consequence tier. Read-only work has no floor: nothing a weak model
 * produces can break anything, so the cheapest adequate configuration is the correct one. Irreversible
 * work bars the lowest band outright, because there effort tuning cannot compensate for capability.
 */
const CONSEQUENCE_ABILITY_FLOOR: Readonly<Record<ConsequenceTier, AbilityTier>> = {
  read_only: 1,
  reversible: 1,
  irreversible: 2,
};

export function authorizeEffort(modelId: string, effort: EffortLevel, context: EffortContext): EffortAuthorization {
  const disqualified = disqualificationReason(modelId);
  if (disqualified) return { authorized: false, reason: `model disqualified by evidence: ${disqualified}` };
  const policy = findEffortPolicy(modelId);
  if (!policy) {
    const bandless = evidenceAbility(modelId, effort);
    const floor = CONSEQUENCE_ABILITY_FLOOR[context.consequence];
    if (bandless !== undefined && bandless < floor) {
      return {
        authorized: false,
        reason: `ability band ${String(bandless)} is below the ${context.consequence} floor of ${String(floor)}`,
      };
    }
    return { authorized: true };
  }

  if (policy.excludedEfforts?.includes(effort)) {
    return { authorized: false, reason: `${effort} excluded: ${policy.excludedReason ?? "measured regression"}` };
  }
  const ability = evidenceAbility(modelId, effort);
  const abilityFloor = CONSEQUENCE_ABILITY_FLOOR[context.consequence];
  if (ability !== undefined && ability < abilityFloor) {
    return {
      authorized: false,
      reason: `ability band ${String(ability)} is below the ${context.consequence} floor of ${String(abilityFloor)}`,
    };
  }
  // The regression minimum applies to anything that changes state, not only to repository writes.
  if (
    consequenceRank(context.consequence) >= consequenceRank("reversible") &&
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
  language?: RoutableLanguage | undefined;
  consequence: ConsequenceTier;
  /**
   * Multiplier on the regression-breakage term. Regression breakage is literally "previously passing
   * tests now fail", so a task that runs those tests catches it before a human sees it, while a task
   * with no verification ships it.
   */
  verificationDiscount: number;
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
  /** The language whose measured pass rate was applied, absent when substitution was not authorized. */
  languageUsed: RoutableLanguage | undefined;
};

/**
 * Pre-telemetry ranking. This is the same robust cost-to-done shape the telemetry path uses,
 * seeded from measured priors instead of observed samples.
 *
 * `costPerPassUsd * passRate` is the mean cost per dispatched attempt, counting upstream failures
 * that recorded no cost as zero. It therefore differs from the corpus's own `mean_cost_usd` column by
 * up to 6.1% on the claude-fable-5 rows, which carry a 3.5-4.9% upstream routing-error rate; every
 * other row matches within 0.5%. Amortizing cost-less failures across attempts is the behavior a
 * router wants, and the direction is slightly in Fable's favor. The token term prices one attempt and
 * the intervention and retry terms price failure, so cost enters selection only through expected
 * completion cost, never as a per-token preference.
 */
export function scoreEvidencePrior(
  row: EvidencePriorRow,
  weights: EvidenceCostWeights,
  context: EvidenceScoreContext,
): EvidenceScore {
  const languagePrior = evidenceLanguagePrior(row, context.language);
  // Pass-rate substitution is the strongest lever a language can pull, so it is gated on the
  // language's declared evidence policy. Regression breakage is substituted whenever a row exists:
  // it is a measurement of the same construct on the same rollouts, and no source disputes it.
  const substitutePassRate = languagePrior !== undefined && languageEvidence(context.language)?.passRateSubstitution;
  const passRate = context.hardTask
    ? substitutePassRate
      ? languagePrior.hardTaskPassRate
      : row.hardTaskPassRate
    : substitutePassRate
      ? languagePrior.passRate
      : row.passRate;
  const regressionBreakRate = languagePrior?.regressionBreakRate ?? row.regressionBreakRate;
  // The three failure terms deliberately overlap on the same events rather than partitioning them:
  // intervention prices "a human had to step in", retry prices "the same task passes inconsistently",
  // and nondeterminism prices "an unattended run cannot trust a single pass". A flaky task on
  // unattended work is charged both retry and nondeterminism, which is intended. Note also that the
  // two repeat-derived rates use the repeated-task denominator (113 tasks) rather than the trial
  // denominator behind passRate (449-452 trials), so they are a different population.
  const components = {
    // costPerPassUsd * corpus passRate is the mean cost of one dispatched attempt (see the note above
    // on cost-less upstream failures); the hard-task pass rate changes the failure price, not what an
    // attempt costs to run.
    attemptCost: row.costPerPassUsd * row.passRate,
    developerWaitCost: weights.developerWaitValuePerMs * context.waitMultiplier * row.p90WallTimeSeconds * 1000,
    humanInterventionCost: weights.humanInterventionCost * (1 - passRate),
    retryCost: weights.retryCost * row.repeatFlakyRate,
    regressionBreakCost:
      consequenceRank(context.consequence) >= consequenceRank("reversible")
        ? weights.regressionBreakCost * regressionBreakRate * context.verificationDiscount
        : 0,
    nondeterminismCost: context.unattended ? weights.nondeterminismCost * (1 - row.repeatAllPassRate) : 0,
  };
  const score = Object.values(components).reduce((total, value) => total + value, 0);
  // A non-finite score would sort arbitrarily and silently mis-route, so refuse it. This catches a
  // missing or non-numeric weight at the first call rather than at ranking time.
  if (!Number.isFinite(score)) {
    throw new Error(`evidence score for ${row.modelId}@${row.effort} is not finite; check the cost weights`);
  }
  return {
    score,
    components,
    passRateUsed: passRate,
    languageUsed: substitutePassRate ? context.language : undefined,
  };
}

/**
 * Hard-task escalation candidate. After a failed attempt on an ambiguous or complex task, the
 * measured evidence favors changing the model prior over raising effort on a saturated incumbent:
 * gpt-5.6-luna at max solves 44.6% of hard tasks corpus-wide, 47.1% on the Go/Python/TypeScript
 * subset, and 44.4% on TypeScript alone, the best in the corpus on each, while being far too flaky
 * (52.7%) to be any archetype's default. Scoring uses the corpus-wide figure.
 */
export const HARD_TASK_ESCALATION = {
  modelId: "gpt-5.6-luna",
  effort: "max",
  reason: "best measured hard-task solver (44.6% corpus-wide, 44.4% TypeScript) despite 52.7% same-task flakiness",
} as const satisfies { modelId: string; effort: EffortLevel; reason: string };
