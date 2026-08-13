import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  abilityFromSingleAttempt,
  evidenceAbility,
  findEvidencePrior,
  findSingleAttemptPrior,
  scoreEvidencePrior,
} from "./evidence.ts";
import { SINGLE_ATTEMPT_CAPTURE, SINGLE_ATTEMPT_PRIOR_ROWS } from "./single-attempt-data.ts";

const specPath = fileURLToPath(
  new URL("../../../specs/routing-layer/single-attempt-evidence-2026-08-14.json", import.meta.url),
);
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const LANGUAGE_SPLITS = ["c", "cpp", "go", "java", "javascript_typescript", "php", "ruby", "rust"];

/**
 * Every field `scoreEvidencePrior` reads off an `EvidencePriorRow`. The single-attempt class must not
 * carry any of them, because five of the six were never measured by a single-attempt submission and a
 * lookalike field name is exactly how an unmeasured term would acquire the weight of a measured one.
 */
const EVIDENCE_SCORING_FIELDS = [
  "passRate",
  "hardTaskPassRate",
  "regressionBreakRate",
  "partialCreditOnFailure",
  "repeatAllPassRate",
  "repeatFlakyRate",
  "contextOverflowRate",
  "medianWallTimeSeconds",
  "p90WallTimeSeconds",
  "medianSteps",
  "p90PeakContextTokens",
  "costPerPassUsd",
  "consensusBest",
];

describe("single-attempt evidence data agrees with the checked-in spec artifact", () => {
  it("carries the same capture date", () => {
    assert.equal(SINGLE_ATTEMPT_CAPTURE, spec.capturedAt);
  });

  it("carries one runtime row per spec row with identical numbers", () => {
    assert.equal(SINGLE_ATTEMPT_PRIOR_ROWS.length, spec.rows.length);
    for (const specRow of spec.rows) {
      const row = findSingleAttemptPrior(specRow.modelId);
      assert.ok(row, `runtime module is missing ${specRow.modelId}`);
      assert.equal(row.scoped, specRow.scoped);
      assert.equal(row.effort, specRow.effort);
      assert.deepEqual(
        row.verified === undefined
          ? undefined
          : {
              nInstances: row.verified.nInstances,
              resolveRate: row.verified.resolveRate,
              costPerTaskUsd: row.verified.costPerTaskUsd,
              medianApiCalls: row.verified.medianApiCalls,
              submission: row.verified.submission,
              date: row.verified.date,
            },
        specRow.verified,
      );
      for (const split of LANGUAGE_SPLITS) {
        assert.deepEqual(row.byLanguage?.[split], specRow.byLanguage?.[split], `${specRow.modelId} ${split}`);
      }
    }
  });

  it("carries no language split the spec does not name", () => {
    for (const row of SINGLE_ATTEMPT_PRIOR_ROWS) {
      for (const split of Object.keys(row.byLanguage ?? {})) {
        assert.ok(LANGUAGE_SPLITS.includes(split), `${row.modelId} carries unexpected split ${split}`);
      }
    }
  });

  it("keeps every rate and cost within its valid range", () => {
    for (const row of SINGLE_ATTEMPT_PRIOR_ROWS) {
      if (row.verified) {
        assert.ok(row.verified.resolveRate >= 0 && row.verified.resolveRate <= 1, `${row.modelId} resolveRate`);
        assert.ok(row.verified.costPerTaskUsd > 0, `${row.modelId} costPerTaskUsd`);
        assert.ok(row.verified.medianApiCalls > 0, `${row.modelId} medianApiCalls`);
        assert.ok(row.verified.nInstances > 0, `${row.modelId} nInstances`);
      }
      for (const slice of Object.values(row.byLanguage ?? {})) {
        assert.ok(slice.resolveRate >= 0 && slice.resolveRate <= 1, `${row.modelId} split resolveRate`);
        assert.ok(slice.costPerResolvedUsd > 0);
        assert.ok(slice.medianApiCalls > 0);
        assert.ok(slice.nInstances > 0);
      }
    }
  });

  it("names the five scoped models the analysis record covers", () => {
    assert.deepEqual(
      SINGLE_ATTEMPT_PRIOR_ROWS.filter((row) => row.scoped)
        .map((row) => row.modelId)
        .sort(),
      ["deepseek-v3.2", "glm-5", "kimi-k2-thinking", "kimi-k2.5", "minimax-m2.5"],
    );
  });
});

describe("single-attempt rows are structurally barred from cost-to-done ranking", () => {
  it("carries none of the fields scoreEvidencePrior reads", () => {
    for (const row of SINGLE_ATTEMPT_PRIOR_ROWS) {
      for (const field of EVIDENCE_SCORING_FIELDS) {
        assert.ok(!(field in row), `${row.modelId} must not carry the scoring field ${field}`);
        assert.equal(row[field], undefined, `${row.modelId} must not expose ${field}`);
      }
      // The nested blocks must not smuggle one in either.
      for (const nested of [row.verified, ...Object.values(row.byLanguage ?? {})]) {
        for (const field of EVIDENCE_SCORING_FIELDS) {
          assert.ok(!(field in (nested ?? {})), `${row.modelId} nested block must not carry ${field}`);
        }
      }
    }
  });

  it("does not satisfy EvidencePriorRow, so scoring it throws rather than scoring a fabricated zero", () => {
    const row = findSingleAttemptPrior("minimax-m2.5");
    assert.ok(row);
    assert.throws(
      () =>
        scoreEvidencePrior(
          row,
          {
            developerWaitValuePerMs: 0.000_001,
            humanInterventionCost: 25,
            retryCost: 10,
            regressionBreakCost: 40,
            nondeterminismCost: 15,
          },
          {
            language: undefined,
            consequence: "read_only",
            verificationDiscount: 1,
            unattended: false,
            waitMultiplier: 1,
            hardTask: false,
          },
        ),
      /is not finite/,
    );
  });

  it("did not leak into the cost-to-done table", () => {
    assert.equal(findEvidencePrior("minimax-m2.5", "low"), undefined);
    for (const row of SINGLE_ATTEMPT_PRIOR_ROWS) {
      for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        assert.equal(findEvidencePrior(row.modelId, effort), undefined, `${row.modelId}@${effort} leaked`);
      }
    }
  });
});

describe("abilityFromSingleAttempt", () => {
  it("gives minimax-m2.5 a band, which no other source can", () => {
    // MiniMax M2.5 has no `model_consensus` row anywhere in the corpus and no DeepSWE rollout row, so
    // this class is its only source of a band. Without it `abilityFor` would have nothing to read.
    assert.equal(evidenceAbility("minimax-m2.5", "low"), undefined);
    const row = findSingleAttemptPrior("minimax-m2.5");
    assert.ok(row);
    assert.equal(abilityFromSingleAttempt(row), 2);
  });

  it("holds glm-5 below band 3 despite its high within-source percentile", () => {
    // GLM-5 sits near the top of the Verified cost-bearing field, but that field tops out at Claude
    // Opus 4.5, so a high percentile within it is not the multi-source percentile that band 3 means.
    const row = findSingleAttemptPrior("glm-5");
    assert.ok(row);
    const band = abilityFromSingleAttempt(row);
    assert.ok(band < 3, `glm-5 resolved to band ${String(band)}`);
    assert.equal(band, 1);
  });

  it("caps every single-attempt row at band 2, the band of the best retained anchor", () => {
    assert.equal(evidenceAbility("claude-opus-4-6", "high"), 2);
    for (const row of SINGLE_ATTEMPT_PRIOR_ROWS) {
      const band = abilityFromSingleAttempt(row);
      if (band !== undefined) assert.ok(band <= 2, `${row.modelId} exceeded the single-attempt cap at ${String(band)}`);
    }
  });

  it("yields no band for a row with no Verified block rather than guessing from language splits", () => {
    assert.equal(abilityFromSingleAttempt({ modelId: "unmeasured", scoped: true, effort: "high" }), undefined);
  });

  it("bands each scoped model against the anchors in the same capture", () => {
    const bands = Object.fromEntries(
      SINGLE_ATTEMPT_PRIOR_ROWS.filter((row) => row.scoped).map((row) => [row.modelId, abilityFromSingleAttempt(row)]),
    );
    assert.deepEqual(bands, {
      // 75.8% Verified resolve, at or above the band-2 anchor claude-opus-4-6 at 75.6%.
      "minimax-m2.5": 2,
      // All four sit below that anchor, so none of them clears band 1 on this evidence.
      "glm-5": 1,
      "kimi-k2.5": 1,
      "deepseek-v3.2": 1,
      "kimi-k2-thinking": 1,
    });
  });
});

describe("existing candidates keep their bands unchanged", () => {
  it("does not route any existing candidate through the single-attempt class", () => {
    // Regression guard for the whole point of the separate class: adding it must not have moved any
    // band that the multi-trial and consensus sources already decide.
    assert.equal(evidenceAbility("claude-opus-5", "high"), 4);
    assert.equal(evidenceAbility("claude-opus-5", "medium"), 3);
    assert.equal(evidenceAbility("claude-opus-5", "low"), 2);
    assert.equal(evidenceAbility("gpt-5.6-sol", "max"), 4);
    assert.equal(evidenceAbility("gpt-5.6-sol", "high"), 3);
    assert.equal(evidenceAbility("gpt-5.6-sol", "medium"), 2);
    assert.equal(evidenceAbility("claude-fable-5", "xhigh"), 4);
    assert.equal(evidenceAbility("claude-sonnet-5", "high"), 1);
    assert.equal(evidenceAbility("gemini-3.6-flash", "high"), 1);
    assert.equal(evidenceAbility("claude-haiku-4-5", "high"), 1);
    assert.equal(evidenceAbility("claude-opus-4-6", "high"), 2);
    assert.equal(evidenceAbility("gpt-oss-120b", "high"), 1);
  });

  it("leaves the anchors banded by their consensus source and not by their resolve rate", () => {
    // claude-haiku-4-5 out-resolves gpt-oss-120b by 40.6 points in this capture, yet both are band 1
    // from consensus. If the new class were feeding evidenceAbility, that equality would not hold.
    assert.equal(evidenceAbility("claude-haiku-4-5", "high"), evidenceAbility("gpt-oss-120b", "high"));
    const haiku = findSingleAttemptPrior("claude-haiku-4-5");
    const gptOss = findSingleAttemptPrior("gpt-oss-120b");
    assert.ok(haiku?.verified && gptOss?.verified);
    assert.ok(haiku.verified.resolveRate > gptOss.verified.resolveRate);
  });
});
