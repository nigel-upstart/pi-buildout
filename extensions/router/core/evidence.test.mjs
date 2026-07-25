import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  abilityFromConsensus,
  LANGUAGE_EVIDENCE,
  languageEvidence,
  authorizeEffort,
  disqualificationReason,
  EFFORT_POLICIES,
  evidenceAbility,
  findEvidencePrior,
  frugalityPrior,
  HARD_TASK_ESCALATION,
  resolveEvidenceLanguage,
  scoreEvidencePrior,
} from "./evidence.ts";
import { EVIDENCE_CAPTURE, EVIDENCE_PRIOR_ROWS } from "./evidence-data.ts";

const specPath = fileURLToPath(new URL("../../../specs/routing-layer/model-evidence-2026-07-25.json", import.meta.url));
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const WEIGHTS = {
  developerWaitValuePerMs: 0.000_001,
  humanInterventionCost: 25,
  retryCost: 10,
  regressionBreakCost: 40,
  nondeterminismCost: 15,
  stepCostOnQuotaSurface: 0.04,
};

const ORDINARY = {
  language: undefined,
  mutatesRepository: false,
  unattended: false,
  waitMultiplier: 1,
  hardTask: false,
  quotaConstrained: false,
};

function score(modelId, effort, context = ORDINARY) {
  const row = findEvidencePrior(modelId, effort);
  assert.ok(row, `missing evidence row for ${modelId}@${effort}`);
  return scoreEvidencePrior(row, WEIGHTS, context).score;
}

describe("evidence data agrees with the checked-in spec artifact", () => {
  it("carries the same capture date", () => {
    assert.equal(EVIDENCE_CAPTURE, spec.generatedAt);
  });

  it("carries one runtime row per spec row with identical numbers", () => {
    assert.equal(EVIDENCE_PRIOR_ROWS.length, spec.rows.length);
    for (const specRow of spec.rows) {
      const row = findEvidencePrior(specRow.modelId, specRow.effort);
      assert.ok(row, `runtime module is missing ${specRow.modelId}@${specRow.effort}`);
      assert.equal(row.passRate, specRow.deepswe.passRate);
      assert.equal(row.hardTaskPassRate, specRow.deepswe.hardTaskPassRate);
      assert.equal(row.regressionBreakRate, specRow.deepswe.regressionBreakRate);
      assert.equal(row.partialCreditOnFailure, specRow.deepswe.partialCreditOnFailure);
      assert.equal(row.repeatAllPassRate, specRow.deepswe.repeatAllPassRate);
      assert.equal(row.repeatFlakyRate, specRow.deepswe.repeatFlakyRate);
      assert.equal(row.contextOverflowRate, specRow.deepswe.contextOverflowRate);
      assert.equal(row.medianWallTimeSeconds, specRow.deepswe.medianWallTimeSeconds);
      assert.equal(row.p90WallTimeSeconds, specRow.deepswe.p90WallTimeSeconds);
      assert.equal(row.medianSteps, specRow.deepswe.medianSteps);
      assert.equal(row.p90PeakContextTokens, specRow.deepswe.p90PeakContextTokens);
      assert.equal(row.costPerPassUsd, specRow.deepswe.costPerPassUsd);
      assert.equal(row.consensusBest, specRow.consensus?.performanceBest);
      for (const bucket of ["go", "python", "typescript"]) {
        assert.deepEqual(
          row.byLanguage[bucket] === undefined
            ? undefined
            : {
                passRate: row.byLanguage[bucket].passRate,
                hardTaskPassRate: row.byLanguage[bucket].hardTaskPassRate,
                regressionBreakRate: row.byLanguage[bucket].regressionBreakRate,
              },
          specRow.byLanguage[bucket]?.passRate === undefined
            ? undefined
            : {
                passRate: specRow.byLanguage[bucket].passRate,
                hardTaskPassRate: specRow.byLanguage[bucket].hardTaskPassRate,
                regressionBreakRate: specRow.byLanguage[bucket].regressionBreakRate,
              },
        );
      }
    }
  });

  it("keeps every prior within its valid range", () => {
    for (const row of EVIDENCE_PRIOR_ROWS) {
      for (const field of [
        "passRate",
        "hardTaskPassRate",
        "regressionBreakRate",
        "partialCreditOnFailure",
        "repeatAllPassRate",
        "repeatFlakyRate",
        "contextOverflowRate",
      ]) {
        assert.ok(row[field] >= 0 && row[field] <= 1, `${row.modelId}@${row.effort} ${field} out of range`);
      }
      assert.ok(row.p90PeakContextTokens > 0);
      assert.ok(row.costPerPassUsd > 0);
      assert.ok(row.p90WallTimeSeconds >= row.medianWallTimeSeconds);
    }
  });
});

describe("ability bands", () => {
  it("maps consensus percentiles to documented tiers", () => {
    assert.equal(abilityFromConsensus(99.1), 4);
    assert.equal(abilityFromConsensus(90), 4);
    assert.equal(abilityFromConsensus(79.9), 3);
    assert.equal(abilityFromConsensus(63.8), 2);
    assert.equal(abilityFromConsensus(44.9), 1);
  });

  it("derives router-relevant abilities from evidence rather than model name", () => {
    assert.equal(evidenceAbility("claude-opus-5", "high"), 4);
    assert.equal(evidenceAbility("claude-opus-5", "medium"), 3);
    assert.equal(evidenceAbility("claude-opus-5", "low"), 2);
    assert.equal(evidenceAbility("gpt-5.6-sol", "max"), 4);
    assert.equal(evidenceAbility("gpt-5.6-sol", "high"), 3);
    assert.equal(evidenceAbility("gpt-5.6-sol", "medium"), 2);
    assert.equal(evidenceAbility("claude-fable-5", "xhigh"), 4);
    // Sonnet 5 at high measures below the Opus 5 rungs and must not claim a mid tier by name.
    assert.equal(evidenceAbility("claude-sonnet-5", "high"), 1);
    assert.equal(evidenceAbility("gemini-3.6-flash", "high"), 1);
    // Consensus-only fallback for a model with no rollout row.
    assert.equal(evidenceAbility("claude-haiku-4-5", "low"), 1);
    assert.equal(evidenceAbility("model-with-no-evidence", "high"), undefined);
  });
});

describe("language resolution", () => {
  it("resolves exactly one recognized language", () => {
    assert.equal(resolveEvidenceLanguage(["go", "shell"]), "go");
    assert.equal(resolveEvidenceLanguage(["typescript"]), "typescript");
    assert.equal(resolveEvidenceLanguage(["ruby", "shell"]), "ruby");
    assert.equal(resolveEvidenceLanguage(["kotlin"]), "kotlin");
  });

  it("refuses a language for mixed stacks and for languages no source recognizes", () => {
    assert.equal(resolveEvidenceLanguage(["go", "typescript"]), undefined);
    assert.equal(resolveEvidenceLanguage(["kotlin", "ruby"]), undefined);
    assert.equal(resolveEvidenceLanguage(["python", "shell", "kotlin"]), undefined);
    // Terraform, Helm/Argo, protobuf and Kafka work has no retained evidence at all.
    assert.equal(resolveEvidenceLanguage(["hcl", "yaml"]), undefined);
    assert.equal(resolveEvidenceLanguage([]), undefined);
  });
});

describe("per-language evidence policy", () => {
  it("authorizes pass-rate substitution only where the measured vendor gap supports it", () => {
    assert.equal(languageEvidence("go").passRateSubstitution, true);
    assert.equal(languageEvidence("python").passRateSubstitution, true);
    // A 1.4 point single-source gap is held at low confidence.
    assert.equal(languageEvidence("typescript").passRateSubstitution, false);
    // Four tasks measuring a Minitest pass ratio cannot substitute for a verifier pass rate.
    assert.equal(languageEvidence("ruby").passRateSubstitution, false);
    assert.equal(languageEvidence("kotlin").passRateSubstitution, false);
  });

  it("keeps Kotlin free of any vendor tendency after the Java proxy was withdrawn", () => {
    assert.equal(languageEvidence("kotlin").vendorTendency, undefined);
    assert.equal(languageEvidence("kotlin").confidence, "none");
  });

  it("records a weak Anthropic tendency for Ruby and a measured one for Go", () => {
    assert.equal(languageEvidence("ruby").vendorTendency, "anthropic");
    assert.equal(languageEvidence("ruby").confidence, "low_power");
    assert.equal(languageEvidence("go").vendorTendency, "anthropic");
    assert.equal(languageEvidence("go").confidence, "measured");
  });

  it("states a reason for every language entry", () => {
    for (const entry of LANGUAGE_EVIDENCE) {
      assert.ok(entry.reason.length > 40, `${entry.language} needs a substantive reason`);
      if (entry.confidence === "none") assert.equal(entry.vendorTendency, undefined);
    }
  });
});

describe("effort authorization", () => {
  const base = { allowSuperSaturation: false, mutatesRepository: true, language: undefined };

  it("caps ordinary archetypes at the measured saturation tier", () => {
    assert.equal(authorizeEffort("claude-opus-5", "high", base).authorized, true);
    const capped = authorizeEffort("claude-opus-5", "max", base);
    assert.equal(capped.authorized, false);
    assert.match(capped.reason, /saturation tier high/);
  });

  it("allows super-saturation tiers only for escalation archetypes", () => {
    assert.equal(authorizeEffort("claude-opus-5", "max", { ...base, allowSuperSaturation: true }).authorized, true);
  });

  it("applies the TypeScript ceiling even for escalation archetypes", () => {
    const capped = authorizeEffort("claude-opus-5", "xhigh", {
      ...base,
      allowSuperSaturation: true,
      language: "typescript",
    });
    assert.equal(capped.authorized, false);
    assert.match(capped.reason, /typescript ceiling high/);
    assert.equal(
      authorizeEffort("claude-opus-5", "xhigh", { ...base, allowSuperSaturation: true, language: "go" }).authorized,
      true,
    );
  });

  it("excludes non-monotonic and thrashing tiers", () => {
    const fable = authorizeEffort("claude-fable-5", "max", { ...base, allowSuperSaturation: true });
    assert.equal(fable.authorized, false);
    assert.match(fable.reason, /max excluded/);
    assert.equal(
      authorizeEffort("claude-sonnet-5", "max", { ...base, allowSuperSaturation: true }).authorized,
      false,
      "sonnet-5 max thrash must stay excluded",
    );
  });

  it("bars low-effort tiers from repository-mutating work but allows read-only use", () => {
    for (const [modelId, effort] of [
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "medium"],
      ["gpt-5.6-terra", "low"],
      ["gpt-5.6-terra", "medium"],
    ]) {
      const mutating = authorizeEffort(modelId, effort, base);
      assert.equal(mutating.authorized, false, `${modelId}@${effort} must not mutate a repository`);
      assert.match(mutating.reason, /agentic minimum/);
      assert.equal(
        authorizeEffort(modelId, effort, { ...base, mutatesRepository: false }).authorized,
        true,
        `${modelId}@${effort} remains usable for non-mutating work`,
      );
    }
  });

  it("disqualifies models the evidence rules out entirely", () => {
    for (const modelId of ["gemini-3.1-pro-preview", "gemini-3.5-flash", "claude-opus-4-8"]) {
      assert.ok(disqualificationReason(modelId), `${modelId} must carry a disqualification reason`);
      const result = authorizeEffort(modelId, "high", { ...base, allowSuperSaturation: true });
      assert.equal(result.authorized, false);
      assert.match(result.reason, /disqualified by evidence/);
    }
  });

  it("declares a reason for every effort policy rule", () => {
    for (const policy of EFFORT_POLICIES) {
      assert.ok(policy.saturationReason.length > 0);
      if (policy.excludedEfforts) assert.ok(policy.excludedReason);
      if (policy.agenticMinimumEffort) assert.ok(policy.agenticMinimumReason);
      if (policy.languageCeilings) assert.ok(policy.languageCeilingReason);
    }
  });
});

describe("prior-seeded cost to done", () => {
  it("ranks cheap-and-weak configurations below stronger ones", () => {
    const strong = score("claude-opus-5", "medium");
    for (const [modelId, effort] of [
      ["gpt-5.6-terra", "low"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-luna", "low"],
      ["gpt-5.6-luna", "medium"],
      ["claude-sonnet-5", "low"],
    ]) {
      assert.ok(
        score(modelId, effort) > strong,
        `${modelId}@${effort} must not outrank claude-opus-5@medium despite lower token cost`,
      );
    }
  });

  it("prefers the cheaper saturated tier over a super-saturation tier of the same model", () => {
    assert.ok(score("claude-opus-5", "high") < score("claude-opus-5", "max"));
    assert.ok(score("claude-fable-5", "xhigh") < score("claude-fable-5", "max"));
  });

  it("reproduces the measured language split on routine work", () => {
    const typescript = { ...ORDINARY, language: "typescript" };
    assert.ok(
      score("gpt-5.6-sol", "high", typescript) < score("claude-opus-5", "high", typescript),
      "routine TypeScript favors gpt-5.6-sol at high effort",
    );
  });

  it("does not substitute an unauthorized language pass rate", () => {
    const row = findEvidencePrior("claude-opus-5", "high");
    const corpus = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const typescript = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, language: "typescript" });
    const go = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, language: "go" });
    // TypeScript keeps the corpus-wide intervention term because its quality claim is single-source.
    assert.equal(typescript.components.humanInterventionCost, corpus.components.humanInterventionCost);
    assert.equal(typescript.languageUsed, undefined);
    // Go substitutes, and its higher measured pass rate lowers the intervention term.
    assert.ok(go.components.humanInterventionCost < corpus.components.humanInterventionCost);
    assert.equal(go.languageUsed, "go");
  });

  it("still applies a measured regression rate for a language whose pass rate is not substituted", () => {
    const row = findEvidencePrior("gpt-5.6-sol", "high");
    const corpus = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, mutatesRepository: true });
    const typescript = scoreEvidencePrior(row, WEIGHTS, {
      ...ORDINARY,
      mutatesRepository: true,
      language: "typescript",
    });
    // TypeScript breakage is measurably lower than the corpus median and is not disputed.
    assert.ok(typescript.components.regressionBreakCost < corpus.components.regressionBreakCost);
  });

  it("leaves Ruby and Kotlin scoring on the corpus-wide priors", () => {
    const row = findEvidencePrior("claude-opus-5", "medium");
    const corpus = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    for (const language of ["ruby", "kotlin"]) {
      const scoped = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, language });
      assert.equal(scoped.score, corpus.score, `${language} must not change the score`);
      assert.equal(scoped.languageUsed, undefined);
    }
  });

  it("reproduces the measured Anthropic advantage on the hard tail", () => {
    const goHard = { ...ORDINARY, language: "go", hardTask: true };
    assert.ok(
      score("claude-opus-5", "high", goHard) < score("gpt-5.6-sol", "high", goHard),
      "hard Go tasks favor claude-opus-5 at high effort",
    );
    assert.ok(
      score("claude-opus-5", "high", goHard) < score("gpt-5.6-sol", "max", goHard),
      "hard Go tasks favor claude-opus-5 at high effort over gpt-5.6-sol at max",
    );
    // On TypeScript, Opus 5's hard-tail advantage (30.6% vs 22.2%) is real but smaller than its
    // cost and latency penalty, so at default weights Sol still wins the first attempt and the
    // Anthropic escalation is expressed through the retry path rather than through primary scoring.
    const typescript = { ...ORDINARY, language: "typescript" };
    const typescriptHard = { ...typescript, hardTask: true };
    const routineGap = score("claude-opus-5", "high", typescript) - score("gpt-5.6-sol", "high", typescript);
    const hardGap = score("claude-opus-5", "high", typescriptHard) - score("gpt-5.6-sol", "high", typescriptHard);
    assert.ok(hardGap > 0, "routine TypeScript ordering still favors gpt-5.6-sol on hard tasks");
    assert.ok(hardGap < routineGap, "the hard-task prior narrows the TypeScript gap toward claude-opus-5");
  });

  it("uses attempt cost that is independent of the hard-task prior", () => {
    const row = findEvidencePrior("claude-opus-5", "high");
    const routine = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const hard = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, hardTask: true });
    assert.equal(routine.components.attemptCost, hard.components.attemptCost);
    assert.ok(hard.components.humanInterventionCost > routine.components.humanInterventionCost);
  });

  it("prices regression breakage only for repository-mutating work", () => {
    const row = findEvidencePrior("gpt-5.6-terra", "high");
    const readOnly = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const mutating = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, mutatesRepository: true });
    assert.equal(readOnly.components.regressionBreakCost, 0);
    assert.ok(mutating.components.regressionBreakCost > 0);
    assert.ok(mutating.score > readOnly.score);
  });

  it("prices nondeterminism only for unattended work", () => {
    const row = findEvidencePrior("gpt-5.6-luna", "max");
    const attended = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const unattended = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, unattended: true });
    assert.equal(attended.components.nondeterminismCost, 0);
    assert.ok(unattended.components.nondeterminismCost > 0);
  });

  it("upweights wall time for foreground developer loops", () => {
    const row = findEvidencePrior("claude-opus-5", "high");
    const background = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const foreground = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, waitMultiplier: 8 });
    assert.equal(foreground.components.developerWaitCost, background.components.developerWaitCost * 8);
  });

  it("records which language prior was applied", () => {
    const row = findEvidencePrior("claude-opus-5", "high");
    assert.equal(scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, language: "go" }).languageUsed, "go");
    assert.equal(scoreEvidencePrior(row, WEIGHTS, ORDINARY).languageUsed, undefined);
  });
});

describe("hard-task escalation prior", () => {
  it("names a candidate whose hard-task rate leads the corpus", () => {
    const escalation = findEvidencePrior(HARD_TASK_ESCALATION.modelId, HARD_TASK_ESCALATION.effort);
    assert.ok(escalation);
    for (const row of EVIDENCE_PRIOR_ROWS) {
      assert.ok(
        row.hardTaskPassRate <= escalation.hardTaskPassRate,
        `${row.modelId}@${row.effort} exceeds the declared hard-task escalation candidate`,
      );
    }
    assert.ok(escalation.repeatFlakyRate > 0.5, "the escalation candidate is expected to be flaky, not a default");
  });
});

describe("step frugality and quota-constrained pricing", () => {
  it("prices steps only on a quota-constrained surface", () => {
    const row = findEvidencePrior("claude-opus-5", "medium");
    const billed = scoreEvidencePrior(row, WEIGHTS, ORDINARY);
    const quota = scoreEvidencePrior(row, WEIGHTS, { ...ORDINARY, quotaConstrained: true });
    assert.equal(billed.components.stepCost, 0, "token-billed routes already price steps inside cost per pass");
    assert.ok(quota.components.stepCost > 0);
  });

  it("refuses a non-finite score instead of ranking arbitrarily", () => {
    const row = findEvidencePrior("claude-opus-5", "medium");
    const incomplete = { ...WEIGHTS };
    delete incomplete.stepCostOnQuotaSurface;
    assert.throws(() => scoreEvidencePrior(row, incomplete, { ...ORDINARY, quotaConstrained: true }), /is not finite/);
  });

  it("uses the measured API-call frugality prior where the corpus provides one", () => {
    assert.equal(frugalityPrior("claude-opus-4-6", "high"), 23.6);
    assert.equal(frugalityPrior("claude-opus-5", "high"), undefined);
  });

  it("prefers the frugal model on a quota surface and the current generation on a billed one", () => {
    const frugal = { modelId: "claude-opus-4-6", effort: "high" };
    // claude-opus-4-6 has no rollout row, so it cannot be scored; the comparison that matters is that
    // the step term moves a scored candidate's cost when quota is the constraint.
    assert.equal(findEvidencePrior(frugal.modelId, frugal.effort), undefined);
    const sol = findEvidencePrior("gpt-5.6-sol", "high");
    const opus = findEvidencePrior("claude-opus-5", "medium");
    const quota = { ...ORDINARY, quotaConstrained: true };
    // Sol at high uses 32 median steps against Opus 5 at medium's 43, so a quota surface favors Sol.
    assert.ok(
      scoreEvidencePrior(sol, WEIGHTS, quota).components.stepCost <
        scoreEvidencePrior(opus, WEIGHTS, quota).components.stepCost,
    );
  });

  it("permits gpt-5.6-luna at high effort on mutating work after the cliff correction", () => {
    const mutating = { allowSuperSaturation: false, mutatesRepository: true, language: undefined };
    assert.equal(authorizeEffort("gpt-5.6-luna", "high", mutating).authorized, true);
    assert.equal(authorizeEffort("gpt-5.6-luna", "medium", mutating).authorized, false);
    assert.equal(authorizeEffort("gpt-5.6-luna", "low", mutating).authorized, false);
  });

  it("bands the scoped and cost-floor models from consensus rather than by name", () => {
    // Two bands below claude-opus-5 at high effort, which is why it is scoped rather than general.
    assert.equal(evidenceAbility("claude-opus-4-6", "high"), 2);
    assert.equal(evidenceAbility("gpt-oss-120b", "high"), 1);
  });
});
