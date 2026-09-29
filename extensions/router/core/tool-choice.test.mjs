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

  it("fails closed for a Bedrock payload that carries no tool specs", () => {
    assert.throws(() => requireToolCall({ modelId: "model" }, "bedrock-converse-stream", "report"), /toolConfig/);
  });

  it("fails closed for an unsupported API", () => {
    assert.throws(() => requireToolCall({}, "unknown-api", "report"), /not configured/);
  });
});
