import assert from "node:assert/strict";
import { it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";

it("Pi declares and executes the refreshed tool set on a generated turn without before_agent_start", async () => {
  const requests = [];
  let executions = 0;
  const reviewTool = {
    name: "submit_safety_review",
    label: "Review",
    description: "Submit a scoped verdict",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executions++;
      return { content: [{ type: "text", text: "Recorded" }], details: {} };
    },
  };
  const agent = new Agent({
    initialState: {
      model: { id: "fixture", provider: "fixture", api: "openai-responses", contextWindow: 100_000 },
      tools: [],
    },
    convertToLlm: (messages) =>
      messages.map((message) =>
        message.role === "custom" ? { role: "user", content: message.content, timestamp: message.timestamp } : message,
      ),
    streamFn: (_model, context) => {
      requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
      const message = {
        role: "assistant",
        api: "openai-responses",
        provider: "fixture",
        model: "fixture",
        content:
          requests.length === 1 ? [{ type: "toolCall", id: "review", name: reviewTool.name, arguments: {} }] : [],
        stopReason: requests.length === 1 ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  // Exercise the actual Pi loadout and generated-message methods with an in-memory Agent.
  // Replace persistence/settling services only; the provider-request and tool-dispatch loop is real.
  const session = Object.assign(Object.create(AgentSession.prototype), {
    agent,
    _toolRegistry: new Map([[reviewTool.name, reviewTool]]),
    _toolDefinitions: new Map(),
    _pendingToolNames: new Set(),
    _toolPromptSnippets: new Map(),
    _toolPromptGuidelines: new Map(),
    _cwd: "/repo",
    _resourceLoader: {
      getSystemPrompt: () => "Review the exact scope",
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    },
    _handlePostAgentRun: async () => false,
    _recordSelection: () => {},
    _runBeforeSettleBoundary: async () => false,
    _flushPendingBashMessages: () => {},
    _flushPendingCustomMessages: () => {},
    _emitAgentSettled: async () => {},
  });
  session.setActiveToolsByName([reviewTool.name]);
  await session.sendCustomMessage(
    { customType: "router-review", content: "Perform the scoped review", display: false },
    { triggerTurn: true },
  );
  assert.equal(agent.state.messages.at(-1)?.errorMessage, undefined);
  assert.deepEqual(requests, [[reviewTool.name], [reviewTool.name]]);
  assert.equal(executions, 1);
});
