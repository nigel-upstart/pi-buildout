import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { classifyTaskWithPi, selectClassifierModels, transportFromCandidates } from "./pi-classifier.ts";

function model(provider, id) {
  return { provider, id };
}

function snapshot(provider, modelId, overrides = {}) {
  const canonicalId = modelId
    .replace(/^(?:us|eu|au|jp|apac|global)\./, "")
    .replace(/^(?:anthropic|openai|google)\./, "");
  const vendor = canonicalId.startsWith("claude-")
    ? "anthropic"
    : canonicalId.startsWith("gemini-")
      ? "google"
      : "openai";
  return {
    provider,
    modelId,
    name: modelId,
    vendor,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    available: true,
    reasoning: true,
    supportedEfforts: ["low"],
    inputTypes: ["text"],
    toolCapable: true,
    costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    ...overrides,
  };
}

function candidate(provider, id, vendor) {
  return { model: model(provider, id), vendor };
}

function request(stage = "primary") {
  return {
    stage,
    systemPrompt: "system",
    userPrompt: "user",
    toolName: "report_task_features",
    toolSchema: {},
  };
}

function rateLimitError(provider) {
  const error = new Error(`${provider}: 429 Too Many Requests - rate limit exceeded`);
  error.status = 429;
  return error;
}

describe("selectClassifierModels", () => {
  it("selects exact configured IDs from different model vendors", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("anthropic", "claude-sonnet-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-5.6-luna");
    assert.equal(selected.primary[0].vendor, "openai");
    assert.equal(selected.secondary[0].model.id, "claude-sonnet-5");
    assert.equal(selected.secondary[0].vendor, "anthropic");
  });

  it("does not downgrade the independent secondary from validated Sonnet to Haiku", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("anthropic", "claude-haiku-4-5"),
    ]);
    assert.equal(selected.primary[0].model.id, "gpt-5.6-luna");
    assert.equal(selected.secondary.length, 0);
  });

  it("does not invent an unconfigured classifier model", () => {
    const selected = selectClassifierModels([snapshot("openai", "gpt-4o")]);
    assert.equal(selected.primary.length, 0);
    assert.equal(selected.secondary.length, 0);
  });

  it("collects every configured Luna endpoint, including direct Amazon Bedrock, ahead of Haiku", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("openai", "gpt-5.6-luna"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-luna"),
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
      snapshot("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      [
        "amazon-bedrock/openai.gpt-5.6-luna",
        "openai-codex/gpt-5.6-luna",
        "openai/gpt-5.6-luna",
        "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
        "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "anthropic/claude-haiku-4-5",
      ],
    );
    // The vendor guess for secondary selection follows the highest-priority tier (Luna/openai),
    // even though multiple endpoints across two vendors were configured.
    assert.equal(selected.primary[0].vendor, "openai");
  });

  it("offers Amazon Bedrock as a secondary endpoint alternative for Sonnet and Terra", () => {
    const openaiPrimary = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
    ]);
    assert.equal(openaiPrimary.secondary[0]?.model.id, "anthropic.claude-sonnet-5");
    assert.equal(openaiPrimary.secondary[0]?.model.provider, "amazon-bedrock");

    const anthropicPrimary = selectClassifierModels([
      snapshot("anthropic", "claude-haiku-4-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(anthropicPrimary.secondary[0]?.model.id, "openai.gpt-5.6-terra");
    assert.equal(anthropicPrimary.secondary[0]?.model.provider, "amazon-bedrock");
  });

  it("chooses both secondary logical tiers from the primary model vendor, not its endpoint provider", () => {
    const openaiSelected = selectClassifierModels([
      snapshot("amazon-bedrock", "openai.gpt-5.6-luna"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(openaiSelected.primary[0]?.vendor, "openai");
    assert.deepEqual(
      openaiSelected.secondary.map((entry) => entry.model.id),
      ["anthropic.claude-sonnet-5"],
    );

    const anthropicSelected = selectClassifierModels([
      snapshot("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
      snapshot("amazon-bedrock", "anthropic.claude-sonnet-5"),
      snapshot("amazon-bedrock", "openai.gpt-5.6-terra"),
    ]);
    assert.equal(anthropicSelected.primary[0]?.vendor, "anthropic");
    assert.deepEqual(
      anthropicSelected.secondary.map((entry) => entry.model.id),
      ["openai.gpt-5.6-terra"],
    );
  });

  it("orders flat-rate endpoints after token-billed alternatives", () => {
    const selected = selectClassifierModels([
      snapshot("github-copilot", "gpt-5.6-luna"),
      snapshot("openai-codex", "gpt-5.6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => entry.model.provider),
      ["openai-codex", "github-copilot"],
    );
    assert.equal(selected.primary[1]?.endpointEffectiveCost, undefined);
  });

  it("excludes endpoints that cannot serve the classifier's forced tool call", () => {
    // Classification is enforced through a forced tool call, so a non-tool-capable endpoint could
    // never satisfy this tier even when it is scoped in, healthy, and the cheapest candidate.
    const selected = selectClassifierModels([
      snapshot("amazon-bedrock", "openai.gpt-5.6-luna", {
        toolCapable: false,
        costPerMillion: { input: 0.01, output: 0.01, cacheRead: 0.001, cacheWrite: 0.01 },
      }),
      snapshot("openai-codex", "gpt-5.6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      ["openai-codex/gpt-5.6-luna"],
    );
  });

  it("declines classification when every scoped endpoint lacks tool support", () => {
    const selected = selectClassifierModels([
      snapshot("openai-codex", "gpt-5.6-luna", { toolCapable: false }),
      snapshot("anthropic", "claude-haiku-4-5", { toolCapable: false }),
    ]);
    assert.deepEqual(selected.primary, []);
    assert.deepEqual(selected.secondary, []);
  });

  it("excludes unavailable and recurring-failure endpoints but retains transient failures", () => {
    const selected = selectClassifierModels([
      snapshot("github-copilot", "gpt-5.6-luna", { available: false }),
      snapshot("openai", "gpt-5.6-luna", {
        health: { provider: "openai", modelId: "gpt-5.6-luna", status: "client_error" },
      }),
      snapshot("bifrost", "gpt-5.6-luna", {
        health: { provider: "bifrost", modelId: "gpt-5.6-luna", status: "failed" },
      }),
      snapshot("amazon-bedrock", "openai.gpt-5.6-luna", {
        health: { provider: "amazon-bedrock", modelId: "openai.gpt-5.6-luna", status: "server_error" },
      }),
      snapshot("google-vertex", "gpt-5.6-luna", {
        health: { provider: "google-vertex", modelId: "gpt-5.6-luna", status: "timeout" },
      }),
      snapshot("openai-codex", "gpt-5.6-luna"),
    ]);
    assert.deepEqual(
      selected.primary.map((entry) => `${entry.model.provider}/${entry.model.id}`),
      ["amazon-bedrock/openai.gpt-5.6-luna", "google-vertex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
    );
  });

  it("returns no candidates when the scoped snapshot contains no classifier model", () => {
    const selected = selectClassifierModels([]);
    assert.deepEqual(selected, { primary: [], secondary: [] });
  });

  it("fails closed without consulting the registry when scope leaves no classifier endpoint", async () => {
    let registryLookups = 0;
    const result = await classifyTaskWithPi({
      ctx: {
        modelRegistry: {
          find: () => {
            registryLookups++;
            return undefined;
          },
        },
      },
      registry: [],
      prompt: "Implement the change",
      synopsis: {},
    });
    assert.equal(result.failedClosed, true);
    assert.equal(registryLookups, 0);
    assert.equal(result.attempts.length, 4);
    assert.ok(result.attempts.every((attempt) => attempt.valid === false));
  });

  it("does not call an alternate endpoint when the provider returns an aborted response", async () => {
    const faux = registerFauxProvider({
      api: "router-classifier-abort-test",
      provider: "router-classifier-abort-test",
      models: [{ id: "abort-fixture" }],
    });
    faux.setResponses([fauxAssistantMessage([], { stopReason: "aborted" })]);
    const registryLookups = [];
    try {
      await assert.rejects(
        classifyTaskWithPi({
          ctx: {
            modelRegistry: {
              find: (provider, modelId) => {
                registryLookups.push(`${provider}/${modelId}`);
                return faux.getModel();
              },
              getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
            },
          },
          registry: [snapshot("a-primary", "gpt-5.6-luna"), snapshot("z-alternate", "gpt-5.6-luna")],
          prompt: "Implement the change",
          synopsis: {},
        }),
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.deepEqual(registryLookups, ["a-primary/gpt-5.6-luna"]);
    } finally {
      faux.unregister();
    }
  });
});

describe("transportFromCandidates", () => {
  it("falls back to the next configured endpoint when the first is rate limited", async () => {
    const attempted = [];
    const transport = transportFromCandidates(
      [candidate("openai-codex", "gpt-5.6-luna", "openai"), candidate("openai", "gpt-5.6-luna", "openai")],
      async (candidateEntry) => {
        attempted.push(candidateEntry.model.provider);
        if (candidateEntry.model.provider === "openai-codex") throw rateLimitError("openai-codex");
        return {
          arguments: { ok: true },
          provider: candidateEntry.model.provider,
          modelId: candidateEntry.model.id,
          vendor: candidateEntry.vendor,
          latencyMs: 10,
        };
      },
    );

    const result = await transport(request());
    assert.deepEqual(attempted, ["openai-codex", "openai"]);
    assert.equal(result.provider, "openai");
  });

  it("tries every Luna endpoint before falling through to the Haiku tier", async () => {
    const attempted = [];
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
      candidate("amazon-bedrock", "openai.gpt-5.6-luna", "openai"),
      candidate("anthropic", "claude-haiku-4-5", "anthropic"),
      candidate("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      if (candidateEntry.vendor === "openai") throw rateLimitError(candidateEntry.model.provider);
      return {
        arguments: { ok: true },
        provider: candidateEntry.model.provider,
        modelId: candidateEntry.model.id,
        vendor: candidateEntry.vendor,
        latencyMs: 10,
      };
    });

    const result = await transport(request());
    assert.deepEqual(attempted, ["openai-codex", "openai", "amazon-bedrock", "anthropic"]);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.modelId, "claude-haiku-4-5");
  });

  it("throws an aggregated error naming every failed endpoint when the whole tier list is exhausted", async () => {
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      throw rateLimitError(candidateEntry.model.provider);
    });

    await assert.rejects(transport(request()), (error) => {
      assert.match(error.message, /openai-codex\/gpt-5\.6-luna/);
      assert.match(error.message, /openai\/gpt-5\.6-luna/);
      assert.match(error.message, /rate limit/);
      return true;
    });
  });

  it("does not retry another endpoint after the caller aborts the request", async () => {
    const attempted = [];
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
    ];
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });

    await assert.rejects(transport(request()), /aborted/i);
    assert.deepEqual(attempted, ["openai-codex"]);
  });

  it("does not retry another endpoint after a transport timeout", async () => {
    const attempted = [];
    const candidates = [
      candidate("openai-codex", "gpt-5.6-luna", "openai"),
      candidate("openai", "gpt-5.6-luna", "openai"),
    ];
    const timeout = new Error("Classifier transport timed out");
    timeout.name = "TimeoutError";
    const transport = transportFromCandidates(candidates, async (candidateEntry) => {
      attempted.push(candidateEntry.model.provider);
      throw timeout;
    });

    await assert.rejects(transport(request()), (error) => error === timeout);
    assert.deepEqual(attempted, ["openai-codex"]);
  });

  it("throws immediately when no endpoint is configured for the required stage", async () => {
    const transport = transportFromCandidates([], async () => {
      throw new Error("should never be called");
    });
    await assert.rejects(
      transport(request("secondary")),
      /No configured secondary classifier from the required vendor/,
    );
  });
});
