import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireToolCall } from "./tool-choice.ts";

describe("requireToolCall", () => {
  it("uses each provider's native forced-tool shape without mutating the payload", () => {
    const payload = { model: "model" };
    assert.deepEqual(requireToolCall(payload, "openai-completions", "report"), {
      model: "model",
      tool_choice: { type: "function", function: { name: "report" } },
    });
    const responsesToolChoice = { type: "function", name: "report" };
    assert.deepEqual(requireToolCall(payload, "openai-responses", "report").tool_choice, responsesToolChoice);
    assert.deepEqual(requireToolCall(payload, "openai-codex-responses", "report").tool_choice, responsesToolChoice);
    assert.deepEqual(requireToolCall(payload, "anthropic-messages", "report").tool_choice, {
      type: "tool",
      name: "report",
    });
    assert.deepEqual(requireToolCall(payload, "google-generative-ai", "report").toolConfig, {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["report"] },
    });
    assert.deepEqual(payload, { model: "model" });
  });

  it("forces the named tool inside a Bedrock Converse toolConfig without mutating the payload", () => {
    const tools = [{ toolSpec: { name: "report" } }];
    const payload = { modelId: "model", toolConfig: { tools, toolChoice: { auto: {} } } };
    assert.deepEqual(requireToolCall(payload, "bedrock-converse-stream", "report").toolConfig, {
      tools,
      toolChoice: { tool: { name: "report" } },
    });
    assert.deepEqual(payload.toolConfig.toolChoice, { auto: {} });
  });

  it("drops budget-style Claude thinking on Bedrock but keeps adaptive thinking", () => {
    const toolConfig = { tools: [{ toolSpec: { name: "report" } }] };
    const budget = {
      toolConfig,
      additionalModelRequestFields: {
        thinking: { type: "enabled", budget_tokens: 2048 },
        anthropic_beta: ["interleaved-thinking-2025-05-14"],
      },
    };
    assert.equal(requireToolCall(budget, "bedrock-converse-stream", "report").additionalModelRequestFields, undefined);
    assert.equal(budget.additionalModelRequestFields.thinking.type, "enabled");

    const withOther = { toolConfig, additionalModelRequestFields: { thinking: { type: "enabled" }, top_k: 5 } };
    assert.deepEqual(requireToolCall(withOther, "bedrock-converse-stream", "report").additionalModelRequestFields, {
      top_k: 5,
    });

    const otherBeta = {
      toolConfig,
      additionalModelRequestFields: {
        thinking: { type: "enabled" },
        anthropic_beta: ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"],
      },
    };
    assert.deepEqual(requireToolCall(otherBeta, "bedrock-converse-stream", "report").additionalModelRequestFields, {
      anthropic_beta: ["context-1m-2025-08-07"],
    });

    const adaptive = {
      toolConfig,
      additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
    };
    assert.deepEqual(
      requireToolCall(adaptive, "bedrock-converse-stream", "report").additionalModelRequestFields,
      adaptive.additionalModelRequestFields,
    );
  });

  it("fails closed for a Bedrock payload that carries no tool specs", () => {
    assert.throws(() => requireToolCall({ modelId: "model" }, "bedrock-converse-stream", "report"), /toolConfig/);
    for (const toolConfig of [{}, { tools: [] }, { tools: "report" }]) {
      assert.throws(() => requireToolCall({ toolConfig }, "bedrock-converse-stream", "report"), /toolConfig/);
    }
  });

  it("fails closed for an unsupported API", () => {
    assert.throws(() => requireToolCall({}, "unknown-api", "report"), /not configured/);
  });
});
