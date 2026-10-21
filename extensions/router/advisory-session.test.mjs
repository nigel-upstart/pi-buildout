import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import routerExtension from "./index.ts";
import { conservativeFeatures } from "./core/features.ts";
import { POLICY_VERSION } from "./core/policy.ts";

// Isolate dispatch from scheduling: initialize the actual router through its lifecycle hooks and
// validators, then mount its unmodified tool hooks in a real Pi session. Only model output and
// routing/model-selection I/O are fixtures; filesystem tools and nested codemode dispatch are real.
async function activeRouter(cwd, sessionId, phase) {
  const hooks = new Map();
  const tools = new Map();
  const entries = [];
  let activeTools = ["read", "write", "bash", "codemode"];
  const choice = (provider, modelId, vendor, profileId) => ({
    provider,
    modelId,
    logicalModelId: modelId,
    vendor,
    profileId,
    effort: "high",
    ability: 4,
    contextWindow: 1_000_000,
    endpointTier: "manufacturer",
    rankReason: "bootstrap",
  });
  const builder = choice("openai-codex", "gpt-6-sol", "openai", "openai-gpt-6-agent-v1");
  const reviewer = choice("anthropic", "claude-opus-5-5", "anthropic", "anthropic-claude-planning-v1");
  const models = [
    builder,
    reviewer,
    choice("google-vertex", "gemini-3.6-flash", "google", "google-gemini-3-review-v1"),
  ].map((entry) => ({
    provider: entry.provider,
    id: entry.modelId,
    name: entry.modelId,
    api: entry.vendor === "openai" ? "openai-responses" : "anthropic-messages",
    input: ["text"],
    reasoning: true,
    contextWindow: entry.contextWindow,
    maxTokens: 128_000,
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  }));
  const now = new Date().toISOString();
  const parent = {
    version: 2,
    taskId: "advisory-session",
    startedAt: now,
    updatedAt: now,
    archetype: "highest_risk_advisory",
    features: {
      ...conservativeFeatures("dispatch regression"),
      intent: "operate",
      workflowType: "incident_or_operations",
      actionMode: "destructive",
      risk: "critical",
      confidence: 0.99,
    },
    selected: builder,
    fallbacks: [reviewer],
    attemptIndex: 0,
    promptProfileId: builder.profileId,
    modelSnapshotId: "fixture",
    policyVersion: POLICY_VERSION,
    lastPromptFingerprint: "fixture",
    lifecycle: {
      phase: phase === "review" ? "planning" : phase,
      policy: phase === "building" ? "completion_review" : "plan_review_then_completion_review",
      taskFingerprint: "dispatch-task",
    },
    safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
    manualOverride: false,
  };
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => models,
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        {
          type: "custom",
          customType: "model-router-state",
          data: { mode: "active", active: parent, manualOverride: false, secondarySafetyPending: false },
        },
      ],
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000, percent: 0 }),
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      notify() {},
    },
  };
  routerExtension(
    {
      on: (name, handler) => hooks.set(name, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand() {},
      appendEntry: (customType, data) => entries.push({ customType, data }),
      sendMessage() {},
      getActiveTools: () => activeTools,
      setActiveTools: (names) => {
        activeTools = names;
      },
      getThinkingLevel: () => "high",
      setThinkingLevel() {},
      setModel: async () => true,
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    },
    { telemetry: { append: async () => {}, read: async () => [] } },
  );
  const latest = () => entries.findLast((entry) => entry.customType === "model-router-state")?.data.active ?? parent;
  await hooks.get("session_start")({ reason: "reload" }, ctx);
  if (phase === "review") {
    await tools.get("submit_action_plan").execute(
      "plan",
      {
        objective: "Inspect a bounded fixture",
        targets: ["fixture"],
        assumptions: [],
        preconditions: ["Temporary directory only"],
        steps: [
          {
            id: "inspect",
            action: "Inspect fixture",
            target: "fixture",
            expectedEffect: "Return metadata",
            potentiallyIrreversible: false,
          },
        ],
        verification: ["Read the fixture"],
        rollback: ["Remove fixture"],
        abortConditions: ["Unexpected target"],
        toolNames: ["read"],
      },
      undefined,
      undefined,
      ctx,
    );
    await hooks.get("agent_settled")({}, ctx);
  }
  assert.equal(latest().lifecycle.phase, phase, "exercise the actual requested router phase");
  return { hooks, latest };
}

for (const phase of ["planning", "executing", "review", "building"]) {
  it(`real Pi dispatch permits direct and codemode mutations during active ${phase}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-advisory-session-"));
    let session;
    const previousScope = process.env.PI_ROUTER_MODEL_SCOPE;
    process.env.PI_ROUTER_MODEL_SCOPE = "*";
    try {
      const manager = SessionManager.inMemory(cwd);
      const { hooks, latest } = await activeRouter(cwd, manager.getSessionId(), phase);
      const calls = [];
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        extensionFactories: [
          createCodemodeExtension({ models: false }),
          (pi) => {
            for (const name of ["tool_execution_start", "tool_execution_end"]) pi.on(name, hooks.get(name));
            pi.on("tool_call", (event, ctx) => {
              assert.equal(latest().lifecycle.phase, phase);
              calls.push(event);
              const result = hooks.get("tool_call")(event, ctx);
              assert.equal(result, undefined, "router observer must never return a block");
              return result;
            });
          },
        ],
      });
      await loader.reload();
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(cwd, "models.json"),
        refreshOnCreate: false,
      });
      runtime.registerProvider("fixture", {
        api: "openai-responses",
        baseUrl: "http://localhost:1",
        apiKey: "fixture",
        models: [{ id: "fixture", name: "Fixture", input: ["text"], contextWindow: 100_000, maxTokens: 1_000 }],
      });
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        resourceLoader: loader,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "fixture"),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          defaultTools: ["read", "write", "bash", "codemode"],
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      }));
      let requests = 0;
      runtime.streamSimple = () => {
        const first = requests++ === 0;
        const message = {
          role: "assistant",
          api: "openai-responses",
          provider: "fixture",
          model: "fixture",
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "direct-write",
                  name: "write",
                  arguments: { path: "direct.txt", content: "direct" },
                },
                { type: "toolCall", id: "direct-bash", name: "bash", arguments: { command: "printf bash > bash.txt" } },
                {
                  type: "toolCall",
                  id: "nested",
                  name: "codemode",
                  arguments: { code: 'text(await tools.write({path: "nested.txt", content: "nested"}));' },
                },
              ]
            : [],
          stopReason: first ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason, message });
        return stream;
      };
      await session.bindExtensions({});
      await session.prompt("Exercise the temporary filesystem tools.");
      assert.equal(session.messages.at(-1)?.stopReason, "stop");
      const results = session.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 3);
      assert.ok(
        results.every((message) => !message.isError),
        JSON.stringify(results),
      );
      for (const name of ["direct", "bash", "nested"])
        assert.equal(await readFile(join(cwd, `${name}.txt`), "utf8"), name);
      assert.equal(calls.length, 4);
      assert.ok(
        calls.some((call) => call.toolName === "write" && call.parentToolCallId === "nested"),
        "nested write traverses Pi's real hook",
      );
      assert.ok(latest().safetyEvidence.mutations.some((entry) => entry.toolName === "write"));
      assert.ok(latest().safetyEvidence.mutations.some((entry) => entry.toolName === "bash"));
    } finally {
      session?.dispose();
      if (previousScope === undefined) delete process.env.PI_ROUTER_MODEL_SCOPE;
      else process.env.PI_ROUTER_MODEL_SCOPE = previousScope;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
