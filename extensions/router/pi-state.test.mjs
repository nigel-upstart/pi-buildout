import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { POLICY_VERSION } from "./core/policy.ts";
import { conservativeFeatures } from "./core/features.ts";
import { createTaskLease } from "./core/lease.ts";
import { selectReviewRoute } from "./core/routing.ts";
import {
  buildRegistrySnapshot,
  cacheEstimate,
  EMPTY_SCOPE,
  estimateFinishedTokens,
  latestReportedContextTokens,
  modelAbility,
  normalizeSessionEntries,
  promptFingerprint,
  readRepositoryMetadata,
  readRouterScope,
  readStartModeResolution,
  restoreLeaseState,
  writeLastKnownMode,
} from "./pi-state.ts";

/** The mode `startMode: "last"` would restore for a repository, with no configuration present. */
async function readStartModeMode(agentDir, repoKey) {
  return (await readStartModeResolution({ agentDir, repoKey })).lastKnownMode;
}

describe("modelAbility", () => {
  it("defers to the authoritative policy and evidence tables for known (model, effort) pairs", () => {
    // Bands come from measured cross-source consensus, not from model names: Opus 5 reaches the top
    // band at high effort while Sonnet 5 and Terra sit in the lowest band there.
    assert.equal(modelAbility("claude-opus-5", "high"), 4);
    assert.equal(modelAbility("claude-opus-5", "medium"), 3);
    assert.equal(modelAbility("claude-opus-5", "low"), 2);
    assert.equal(modelAbility("gpt-5.6-sol", "max"), 4);
    assert.equal(modelAbility("gpt-5.6-sol", "high"), 3);
    assert.equal(modelAbility("claude-sonnet-5", "high"), 1);
    assert.equal(modelAbility("gpt-5.6-terra", "high"), 1);
    // A resale endpoint resolves to the same band as the model it serves.
    assert.equal(modelAbility("global.anthropic.claude-opus-5", "high"), 4);
  });

  it("falls back to a pessimistic heuristic only for unmeasured models", () => {
    assert.equal(modelAbility("some-unknown-mini", "low"), 1);
    assert.equal(modelAbility("some-unknown-flash", "high"), 1);
    // "pro" and "max" in a model name are not capability signals and must not grant a tier.
    assert.equal(modelAbility("some-unknown-pro", "medium"), 2);
    assert.equal(modelAbility("some-unknown-model", "max"), 3);
  });

  it("selects reviewers at or above the builder band end to end", () => {
    // Regression for reviewer skew: reviewers must be chosen from the evidence-derived ladder rather
    // than from a name heuristic, and no ladder rung may sit below the builder's measured band.
    const registryModel = (provider, modelId, vendor) => ({
      provider,
      modelId,
      name: modelId,
      vendor,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      available: true,
      reasoning: true,
      supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      inputTypes: ["text", "image"],
      toolCapable: true,
      costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
    });
    const registry = [
      registryModel("openai-codex", "gpt-5.6-terra", "openai"),
      registryModel("openai-codex", "gpt-5.6-sol", "openai"),
      registryModel("anthropic", "claude-opus-5", "anthropic"),
      registryModel("google-vertex", "gemini-3.6-flash", "google"),
    ];
    const builder = registry.find((candidate) => candidate.modelId === "gpt-5.6-sol");
    const decision = selectReviewRoute(
      registry,
      { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true },
      builder,
      "high",
      modelAbility("gpt-5.6-sol", "high"),
    );
    assert.equal(decision.kind, "review");
    const reviewers = new Map([decision.primary, decision.fallback].map((choice) => [choice.vendor, choice]));
    // An ability-3 builder draws the Anthropic rung at or above its band and Google's only rung,
    // which sits below it and is therefore recorded as a ceiling mismatch instead of passing silently.
    assert.equal(reviewers.get("anthropic").modelId, "claude-opus-5");
    assert.equal(reviewers.get("anthropic").ability, 3);
    assert.equal(reviewers.get("google").modelId, "gemini-3.6-flash");
    assert.deepEqual(decision.ceilingMismatchVendors, ["google"]);
    assert.ok([decision.primary, decision.fallback].every((choice) => choice.vendor !== builder.vendor));
  });
});

describe("router scope configuration", () => {
  async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "pi-router-scope-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return {
      project: join(root, "project"),
      projectSettings: join(root, "project", ".pi", "settings.json"),
      userSettings: join(root, "user", "settings.json"),
      health: join(root, "health.json"),
    };
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), "utf8");
  }

  it("reads isolated project and user settings with per-provider environment precedence", async (t) => {
    const paths = await fixture(t);
    await writeJson(paths.projectSettings, {
      enabledModels: ["amazon-bedrock/*"],
      routerProviderWeights: { "amazon-bedrock": 0.8, openai: { weight: 1.2, basis: "contract" } },
    });
    await writeJson(paths.userSettings, {
      enabledModels: ["anthropic/*"],
      routerProviderWeights: { "amazon-bedrock": 0.7, anthropic: 0.9 },
    });
    const environment = {
      PI_ROUTER_PROVIDER_WEIGHTS: JSON.stringify({ "amazon-bedrock": 0.6 }),
    };
    const scope = await readRouterScope(paths.project, {
      environment,
      userSettingsPath: paths.userSettings,
      healthPath: paths.health,
    });

    assert.deepEqual(scope.patterns, ["amazon-bedrock/*"]);
    assert.deepEqual(scope.providerWeights.get("amazon-bedrock"), {
      weight: 0.6,
      basis: "preference",
      source: "environment",
    });
    assert.deepEqual(scope.providerWeights.get("openai"), {
      weight: 1.2,
      basis: "contract",
      source: "project",
    });
    assert.deepEqual(scope.providerWeights.get("anthropic"), {
      weight: 0.9,
      basis: "preference",
      source: "user",
    });
    assert.deepEqual(scope.providerWeightRejections, []);

    const registryModel = getModel("amazon-bedrock", "openai.gpt-5.6-sol");
    assert.ok(registryModel);
    const snapshots = buildRegistrySnapshot(
      {
        modelRegistry: {
          getAll: () => [registryModel],
          getAvailable: () => [registryModel],
        },
      },
      scope,
    );
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].providerWeight, scope.providerWeights.get("amazon-bedrock"));
  });

  it("records malformed environment JSON while retaining best-effort file fallback", async (t) => {
    const paths = await fixture(t);
    await mkdir(dirname(paths.projectSettings), { recursive: true });
    await writeFile(paths.projectSettings, "{not-json", "utf8");
    await writeJson(paths.userSettings, {
      enabledModels: ["anthropic/*"],
      routerProviderWeights: { anthropic: 0.9 },
    });
    const scope = await readRouterScope(paths.project, {
      environment: { PI_ROUTER_PROVIDER_WEIGHTS: "anthropic=0.5" },
      userSettingsPath: paths.userSettings,
      healthPath: paths.health,
    });

    assert.deepEqual(scope.patterns, ["anthropic/*"]);
    assert.equal(scope.providerWeights.get("anthropic").weight, 0.9);
    assert.equal(scope.providerWeights.get("anthropic").source, "user");
    assert.equal(scope.providerWeightRejections.length, 1);
    assert.equal(scope.providerWeightRejections[0].source, "environment");
    assert.match(scope.providerWeightRejections[0].reason, /valid JSON/);
  });

  it("uses immutable built-ins when isolated settings files are missing or malformed", async (t) => {
    assert.equal(Object.isFrozen(EMPTY_SCOPE), true);
    assert.equal(Object.isFrozen(EMPTY_SCOPE.patterns), true);
    assert.equal(typeof EMPTY_SCOPE.providerWeights.set, "undefined");
    assert.deepEqual(EMPTY_SCOPE.providerWeights.get("amazon-bedrock"), {
      weight: 0.83,
      basis: "contract",
      source: "built-in",
    });

    const missing = await fixture(t);
    const missingScope = await readRouterScope(missing.project, {
      environment: {},
      userSettingsPath: missing.userSettings,
      healthPath: missing.health,
    });
    assert.deepEqual(missingScope.patterns, []);
    assert.deepEqual(missingScope.providerWeights.get("amazon-bedrock"), {
      weight: 0.83,
      basis: "contract",
      source: "built-in",
    });

    const malformed = await fixture(t);
    await mkdir(dirname(malformed.projectSettings), { recursive: true });
    await mkdir(dirname(malformed.userSettings), { recursive: true });
    await writeFile(malformed.projectSettings, "null", "utf8");
    await writeFile(malformed.userSettings, "[", "utf8");
    const malformedScope = await readRouterScope(malformed.project, {
      environment: {},
      userSettingsPath: malformed.userSettings,
      healthPath: malformed.health,
    });
    assert.deepEqual(malformedScope.patterns, []);
    assert.equal(malformedScope.providerWeights.get("openai").weight, 1.001);
    assert.deepEqual(malformedScope.providerWeightRejections, []);
  });
});

describe("normalizeSessionEntries", () => {
  it("extracts bounded semantic state and tool paths from pi entries", () => {
    const entries = normalizeSessionEntries([
      { type: "message", message: { role: "user", content: "Implement it" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/a.ts" } }],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "edit", isError: false },
      },
      {
        type: "compaction",
        summary: "Decision: use TypeBox",
        details: { readFiles: ["README.md"], modifiedFiles: ["src/a.ts"] },
      },
    ]);
    assert.deepEqual(entries[0], { kind: "user", text: "Implement it" });
    assert.deepEqual(entries[2], { kind: "tool", toolName: "edit", path: "src/a.ts", isError: false });
    assert.deepEqual(entries[3].modifiedFiles, ["src/a.ts"]);
  });
});

describe("lease restoration and context estimates", () => {
  it("restores only router-authored state entries", () => {
    const state = restoreLeaseState(
      [
        { type: "custom", customType: "other", data: { mode: "active" } },
        { type: "custom", customType: "model-router-state", data: { mode: "active", manualOverride: true } },
      ],
      "shadow",
    );
    assert.deepEqual(state, { mode: "active", manualOverride: true });

    const active = createTaskLease({
      taskId: "task",
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      archetype: "highest_risk_advisory",
      features: conservativeFeatures(),
      selected: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        logicalModelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "max",
        ability: 4,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      fallbacks: [
        {
          provider: "anthropic",
          modelId: "claude-opus-5",
          logicalModelId: "claude-opus-5",
          vendor: "anthropic",
          effort: "high",
          ability: 3,
          profileId: "anthropic-claude-planning-v1",
          contextWindow: 1_000_000,
          endpointTier: "manufacturer",
          rankReason: "bootstrap",
        },
      ],
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
    });
    active.planValidationRepairAttempted = true;
    const restored = restoreLeaseState(
      [{ type: "custom", customType: "model-router-state", data: { mode: "active", active } }],
      "shadow",
    );
    assert.equal(restored.active.taskId, "task");
    assert.equal(restored.active.planValidationRepairAttempted, true);
    const malformedRepair = structuredClone(active);
    malformedRepair.planValidationRepairAttempted = "yes";
    assert.equal(
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: malformedRepair } }],
        "shadow",
      ).active,
      undefined,
    );
    const legacyImplicitChild = structuredClone(active);
    legacyImplicitChild.parentTaskId = active.taskId;
    legacyImplicitChild.parentLease = structuredClone(active);
    assert.equal(
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: legacyImplicitChild } }],
        "shadow",
      ).active,
      undefined,
      "parent-linked leases without an explicit review lifecycle must fail closed",
    );
    const malformedIndependentReview = structuredClone(active);
    malformedIndependentReview.lifecycle = {
      phase: "review",
      policy: "ordinary",
      taskFingerprint: active.lifecycle.taskFingerprint,
      reviewKind: "completion",
      scopeFingerprint: "a".repeat(64),
    };
    assert.equal(
      restoreLeaseState(
        [
          {
            type: "custom",
            customType: "model-router-state",
            data: { mode: "active", active: malformedIndependentReview },
          },
        ],
        "shadow",
      ).active,
      undefined,
      "the generated review lifecycle requires a code-review child and explicit parent lease",
    );
    const legacyVersion = structuredClone(active);
    legacyVersion.version = 1;
    assert.equal(
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: legacyVersion } }],
        "shadow",
      ).active,
      undefined,
      "leases without explicit v2 lifecycle state must be discarded",
    );
    const tampered = structuredClone(active);
    tampered.selected.modelId = "unknown-model";
    assert.equal(
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: tampered } }],
        "shadow",
      ).active,
      undefined,
    );

    const restore = (lease) =>
      restoreLeaseState(
        [{ type: "custom", customType: "model-router-state", data: { mode: "active", active: lease } }],
        "shadow",
      ).active;

    // The effective cost is optional so leases without it remain compatible, while newly written
    // values persist and malformed pricing data fails closed.
    assert.equal(restore(active)?.selected.endpointEffectiveCost, undefined);
    const withEffectiveCost = structuredClone(active);
    withEffectiveCost.selected.endpointEffectiveCost = 23.75;
    withEffectiveCost.fallbacks[0].endpointEffectiveCost = 20;
    const restoredEffectiveCost = restore(withEffectiveCost);
    assert.equal(restoredEffectiveCost?.selected.endpointEffectiveCost, 23.75);
    assert.equal(restoredEffectiveCost?.fallbacks[0].endpointEffectiveCost, 20);
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const malformedCost = structuredClone(withEffectiveCost);
      malformedCost.selected.endpointEffectiveCost = invalid;
      assert.equal(restore(malformedCost), undefined, `${String(invalid)} effective cost must be rejected`);
    }
    const flatRateCost = structuredClone(withEffectiveCost);
    flatRateCost.selected.provider = "github-copilot";
    flatRateCost.selected.endpointTier = "resale";
    assert.equal(restore(flatRateCost), undefined, "flat-rate choices cannot persist a token effective cost");

    // Accepts a regional spelling that exact-ID eligibility used to reject. eu.anthropic.claude-sonnet-5
    // is a real Bedrock region profile that was never in the hand-maintained spelling list, so a lease
    // recorded against it was discarded on restore even though the endpoint was authorized.
    const resaleSpelling = structuredClone(active);
    resaleSpelling.fallbacks[0].provider = "amazon-bedrock";
    resaleSpelling.fallbacks[0].modelId = "eu.anthropic.claude-sonnet-5";
    resaleSpelling.fallbacks[0].logicalModelId = "claude-sonnet-5";
    resaleSpelling.fallbacks[0].profileId = "anthropic-claude-fast-agent-v1";
    resaleSpelling.fallbacks[0].endpointTier = "resale";
    assert.equal(
      restore(resaleSpelling)?.fallbacks[0].modelId,
      "eu.anthropic.claude-sonnet-5",
      "a canonical-eligible resale spelling must survive restore",
    );

    // Rejects a lease whose recorded logical ID is not the canonical form of its registry ID. This is
    // the shape the pre-canonicalization bootstrap path wrote, and it must not be trusted, because
    // every later comparison keys off the logical ID.
    const staleLogicalId = structuredClone(resaleSpelling);
    staleLogicalId.fallbacks[0].logicalModelId = "eu.anthropic.claude-sonnet-5";
    assert.equal(
      restore(staleLogicalId),
      undefined,
      "a lease whose logical ID is a registry spelling must be discarded",
    );

    // Rejects a lease whose profile pairing no longer exists. Canonicalization widened which
    // spellings resolve a profile; it did not weaken the pairing check.
    const vanishedProfile = structuredClone(active);
    vanishedProfile.selected.profileId = "anthropic-claude-planning-v1";
    assert.equal(restore(vanishedProfile), undefined, "a lease naming another vendor's profile must be discarded");
    const unpairedEffort = structuredClone(active);
    unpairedEffort.fallbacks[0].effort = "off";
    assert.equal(
      restore(unpairedEffort),
      undefined,
      "a lease whose archetype/effort pairing has no profile must be discarded",
    );
  });

  it("adds deterministic tool, response, change, and compaction reserves", () => {
    const estimate = estimateFinishedTokens(10_000, {
      expectedToolOutputTokens: 20_000,
      expectedAgentTurns: 4,
      expectedFilesChanged: 2,
    });
    assert.equal(estimate, 54_384);
    assert.equal(promptFingerprint("same"), promptFingerprint("same"));
    assert.notEqual(promptFingerprint("same"), promptFingerprint("different"));
  });

  it("derives cache value from the latest assistant usage", () => {
    const entries = [
      {
        type: "message",
        message: { role: "assistant", usage: { input: 40_000, cacheRead: 25_000, output: 2_000 } },
      },
    ];
    assert.deepEqual(cacheEstimate(entries), { cachedTokens: 25_000, expectedReuseRatio: 0.625 });
    assert.equal(latestReportedContextTokens(entries), 67_000);
  });
});

describe("readRepositoryMetadata", () => {
  it("inspects a standalone review delta without mutating it", async () => {
    const calls = [];
    const metadata = await readRepositoryMetadata(
      {
        exec: async (command, args) => {
          calls.push([command, ...args]);
          if (command === "gh") {
            return {
              code: 0,
              stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
              stderr: "",
              killed: false,
            };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        },
      },
      "/repo",
      "Review PR #305 for correctness and risk",
    );
    assert.equal(metadata.reviewDelta.source, "pull_request");
    assert.equal(metadata.reviewDelta.reference, "PR #305");
    assert.deepEqual(metadata.reviewDelta.files, ["src/a.ts"]);
    assert.deepEqual(metadata.reviewDelta.languageBuckets, ["typescript"]);
    assert.ok(calls.some((call) => call.join(" ") === "gh pr diff 305 --patch"));
    assert.ok(calls.every((call) => !call.includes("checkout") && !call.includes("fetch")));
  });

  it("falls back to the working-tree diff when no pull request is referenced", async () => {
    const calls = [];
    const metadata = await readRepositoryMetadata(
      {
        exec: async (command, args) => {
          calls.push([command, ...args]);
          if (command === "git" && args.includes("diff")) {
            return {
              code: 0,
              stdout: [
                "diff --git a/src/a.ts b/src/a.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
                "diff --git a/scripts/run.sh b/scripts/run.sh",
                "@@ -1 +1 @@",
                "-echo old",
                "+echo new",
              ].join("\n"),
              stderr: "",
              killed: false,
            };
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        },
      },
      "/repo",
      "Review my uncommitted work for correctness",
    );
    assert.equal(metadata.reviewDelta.source, "working_tree");
    assert.equal(metadata.reviewDelta.reference, "HEAD to working tree/index");
    assert.deepEqual(metadata.reviewDelta.files, ["src/a.ts", "scripts/run.sh"]);
    assert.deepEqual(metadata.reviewDelta.languageBuckets, ["shell", "typescript"]);
    assert.ok(
      calls.some((call) => call.join(" ") === "git -C /repo diff --no-ext-diff --unified=1 HEAD --"),
      "the working-tree delta is read with a bounded diff",
    );
    assert.ok(calls.every((call) => call[0] !== "gh"));
    assert.ok(calls.every((call) => !call.includes("checkout") && !call.includes("fetch")));
  });

  it("uses git state and deterministic language buckets", async () => {
    const outputs = new Map([
      ["rev-parse --show-toplevel", "/repo"],
      ["rev-parse HEAD", "abc"],
      ["rev-parse --verify @{upstream}", "def"],
      ["status --porcelain=v1 --untracked-files=normal", " M src/a.ts\n?? src/new.py"],
      ["ls-files", "src/a.ts\nsrc/new.py\napp/Main.kt\nscripts/deploy.sh\nREADME.md"],
    ]);
    const metadata = await readRepositoryMetadata(
      {
        exec: async (_command, args) => {
          const key = args.slice(2).join(" ");
          return { code: 0, stdout: outputs.get(key) ?? "", stderr: "", killed: false };
        },
      },
      "/repo",
    );
    assert.equal(metadata.upstream, "def");
    assert.deepEqual(metadata.changedFiles, ["src/a.ts", "src/new.py"]);
    assert.deepEqual(metadata.languageBuckets, ["kotlin", "python", "shell", "typescript"]);
  });
});

describe("last known router mode", () => {
  it("keeps concurrent per-repository records instead of letting one writer drop another", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-router-last-mode-concurrency-"));
    const previousPath = process.env.PI_ROUTER_LAST_MODE_PATH;
    process.env.PI_ROUTER_LAST_MODE_PATH = join(directory, "router-last-mode.jsonl");
    try {
      // Two pi processes in different checkouts stop at the same moment.
      await Promise.all([
        writeLastKnownMode(directory, "github.com:org/first", "active"),
        writeLastKnownMode(directory, "github.com:org/second", "off"),
        writeLastKnownMode(directory, undefined, "shadow"),
      ]);
      assert.equal(await readStartModeMode(directory, "github.com:org/first"), "active");
      assert.equal(await readStartModeMode(directory, "github.com:org/second"), "off");
      // An unknown repository falls back to the most recent machine-wide record.
      assert.ok(["active", "off", "shadow"].includes(await readStartModeMode(directory, "github.com:org/third")));
    } finally {
      if (previousPath === undefined) delete process.env.PI_ROUTER_LAST_MODE_PATH;
      else process.env.PI_ROUTER_LAST_MODE_PATH = previousPath;
    }
  });

  it("records the newest mode per repository and survives a truncated line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-router-last-mode-newest-"));
    const previousPath = process.env.PI_ROUTER_LAST_MODE_PATH;
    const path = join(directory, "router-last-mode.jsonl");
    process.env.PI_ROUTER_LAST_MODE_PATH = path;
    try {
      await writeLastKnownMode(directory, "github.com:org/repo", "active");
      await appendFile(path, '{"version":1,"repoKey":"github.com:org/re\n', "utf8");
      await writeLastKnownMode(directory, "github.com:org/repo", "off");
      assert.equal(await readStartModeMode(directory, "github.com:org/repo"), "off");
    } finally {
      if (previousPath === undefined) delete process.env.PI_ROUTER_LAST_MODE_PATH;
      else process.env.PI_ROUTER_LAST_MODE_PATH = previousPath;
    }
  });
});
