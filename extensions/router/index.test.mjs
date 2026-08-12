import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// The router derives candidates from the operator's model scope, so tests pin it explicitly rather
// than reading whatever the developer happens to have enabled.
process.env.PI_ROUTER_MODEL_SCOPE = "*";
process.env.PI_ROUTER_ENDPOINT_HEALTH_PATH = "/nonexistent-router-health.json";
// Recording the last known mode is a real filesystem write; keep every test out of the developer's
// agent directory unless the test points it somewhere itself.
process.env.PI_ROUTER_LAST_MODE_PATH = join(await mkdtemp(join(tmpdir(), "pi-router-last-mode-")), "last-mode.jsonl");
import { POLICY_VERSION } from "./core/policy.ts";
import { conservativeFeatures } from "./core/features.ts";
import routerExtension, {
  activeToolsForSafetyLifecycle,
  automaticRoutingBlockReason,
  deterministicCheckCommand,
  resumeCompletedLifecycle,
  routeChoicesForNewLease,
  safetyToolBlockReason,
} from "./index.ts";

function irreversibleActionPlan() {
  return {
    objective: "Rotate the production credential under a bounded overlap window.",
    targets: ["production/keyring"],
    assumptions: ["The old credential remains valid during overlap."],
    preconditions: ["Break-glass access has been tested."],
    steps: [
      {
        id: "rotate",
        action: "Create the replacement, activate it, then revoke the old credential.",
        target: "production/keyring",
        expectedEffect: "The old credential permanently stops authenticating.",
        potentiallyIrreversible: true,
      },
    ],
    verification: ["Authenticate with the replacement from two clients."],
    rollback: ["Reactivate the old credential before overlap ends."],
    abortConditions: ["Stop if break-glass access or replacement verification fails."],
    authorizedToolNames: ["bash"],
  };
}

describe("automatic routing gate", () => {
  it("requires validated semantic evidence instead of promoting classifier failure to a premium route", () => {
    assert.match(automaticRoutingBlockReason({ failedClosed: true }), /validated semantic evidence/);
    assert.equal(automaticRoutingBlockReason({ failedClosed: false }), undefined);
  });
});

describe("deterministicCheckCommand", () => {
  it("accepts exit-preserving checks and rejects shell constructs that can mask failure", () => {
    assert.equal(deterministicCheckCommand("npm test && npm run lint"), "npm test && npm run lint");
    assert.equal(deterministicCheckCommand("npm test; true"), undefined);
    assert.equal(deterministicCheckCommand("npm test || true"), undefined);
    assert.equal(deterministicCheckCommand("npm test | tee test.log"), undefined);
    assert.equal(deterministicCheckCommand("npm test & wait"), undefined);
    assert.equal(deterministicCheckCommand("echo hello"), undefined);
  });
});

/** Runs a startup `session_start` against a session with no router history and returns persisted state. */
async function startupRouterState(overrides = {}) {
  const hooks = new Map();
  const appended = [];
  routerExtension({
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType, data) => appended.push({ customType, data }),
    ...overrides,
  });
  await hooks.get("session_start")(
    { type: "session_start", reason: "startup" },
    {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "startup-session", getBranch: () => [] },
      modelRegistry: { getAvailable: () => [], getAll: () => [] },
      model: undefined,
      getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
      ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_color, text) => text } },
    },
  );
  return appended.filter((entry) => entry.customType === "model-router-state");
}

function restoreEnv({ previousAgentDir, previousMode, previousLastModePath }) {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
  else process.env.PI_ROUTER_MODE = previousMode;
  if (previousLastModePath === undefined) delete process.env.PI_ROUTER_LAST_MODE_PATH;
  else process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
}
describe("resumeCompletedLifecycle", () => {
  it("restores an approval only inside the session that obtained it", () => {
    const plan = {
      taskFingerprint: "task",
      planFingerprint: "f".repeat(64),
      submittedAt: "2026-07-28T00:00:00.000Z",
      plan: irreversibleActionPlan(),
    };
    const completed = {
      phase: "completed",
      policy: "authorization_then_completion_review",
      taskFingerprint: "task",
      completionReview: {
        kind: "completion",
        verdict: "pass",
        summary: "done",
        completedAt: "2026-07-28T01:00:00.000Z",
      },
      plan,
      authorization: {
        taskFingerprint: "task",
        planFingerprint: plan.planFingerprint,
        reviewTaskId: "review",
        reviewerVendor: "anthropic",
        sessionId: "approving-session",
        approvedAt: "2026-07-28T00:01:00.000Z",
      },
    };
    assert.equal(resumeCompletedLifecycle(completed, "approving-session").phase, "authorized_execution");
    const elsewhere = resumeCompletedLifecycle(completed, "another-session");
    assert.equal(elsewhere.phase, "preflight", "an approval must not cross a session boundary");
    assert.equal(elsewhere.authorization, undefined);
    assert.equal(elsewhere.plan.planFingerprint, plan.planFingerprint, "the submitted plan survives re-authorization");
  });
});

describe("lease-scoped tool exposure", () => {
  it("exposes each safety validator only in the lifecycle phase that can accept it", () => {
    const ordinaryTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    assert.deepEqual(activeToolsForSafetyLifecycle(ordinaryTools, undefined), ["read", "bash"]);
    assert.deepEqual(
      activeToolsForSafetyLifecycle(ordinaryTools, {
        phase: "preflight",
        policy: "authorization_then_completion_review",
        taskFingerprint: "task",
      }),
      ["read", "bash", "submit_action_plan"],
    );
    assert.deepEqual(
      activeToolsForSafetyLifecycle(ordinaryTools, {
        phase: "review",
        policy: "ordinary",
        taskFingerprint: "task",
        reviewKind: "completion",
        scopeFingerprint: "a".repeat(64),
      }),
      ["read", "bash", "submit_safety_review"],
    );
  });
});

describe("manual route selection at a new task boundary", () => {
  it("preserves the explicit model and effort while replacing the stale task lease", () => {
    const current = {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      logicalModelId: "gpt-5.6-luna",
      vendor: "openai",
      effort: "low",
      ability: 1,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 272_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    const routed = { ...current, modelId: "gpt-5.6-sol", logicalModelId: "gpt-5.6-sol", effort: "high", ability: 3 };
    const fallback = {
      ...routed,
      provider: "anthropic",
      modelId: "claude-opus-5",
      logicalModelId: "claude-opus-5",
      vendor: "anthropic",
    };
    const preserved = routeChoicesForNewLease(routed, [fallback], current, true);
    assert.equal(preserved.selected, current);
    assert.equal(preserved.previousSelection, current);
    assert.deepEqual(preserved.fallbacks, [routed, fallback]);

    const automatic = routeChoicesForNewLease(routed, [fallback], current, false);
    assert.equal(automatic.selected, routed);
    assert.deepEqual(automatic.fallbacks, [fallback]);
  });

  it("does not duplicate the explicit selection in fallback order", () => {
    const selected = {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      logicalModelId: "gpt-5.6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 272_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    assert.deepEqual(routeChoicesForNewLease(selected, [selected], selected, true).fallbacks, []);
  });
});

describe("safetyToolBlockReason", () => {
  it("restricts explicit lifecycle phases without treating standalone review as a child review", () => {
    const standaloneReview = {
      manualOverride: false,
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task" },
    };
    assert.equal(safetyToolBlockReason(standaloneReview, "subagent", { action: "create" }), undefined);
    assert.equal(
      safetyToolBlockReason(standaloneReview, "bash", { command: "gh pr comment 305 --body review" }),
      undefined,
    );

    const independentReview = {
      manualOverride: false,
      lifecycle: {
        phase: "review",
        policy: "ordinary",
        taskFingerprint: "task",
        reviewKind: "completion",
        scopeFingerprint: "a".repeat(64),
      },
    };
    assert.equal(safetyToolBlockReason(independentReview, "bash", { command: "git diff --stat" }), undefined);
    assert.match(safetyToolBlockReason(independentReview, "subagent", { action: "create" }), /read-only/);
    assert.match(
      safetyToolBlockReason(independentReview, "bash", { command: "gh pr comment 305 --body review" }),
      /read-only/,
    );
    assert.match(
      safetyToolBlockReason({ ...independentReview, manualOverride: true }, "submit_safety_review", {}),
      /Manual.*invalidated/,
    );
    assert.equal(
      safetyToolBlockReason({ ...standaloneReview, manualOverride: true }, "edit", { path: "README.md" }),
      undefined,
      "a manual override on ordinary work must not block normal tools",
    );
    assert.equal(
      safetyToolBlockReason({ ...standaloneReview, manualOverride: true }, "bash", { command: "npm test" }),
      undefined,
    );
  });
});

describe("routerExtension", () => {
  it("registers the routing lifecycle and status command without starting background work", () => {
    const hooks = new Map();
    const commands = new Map();
    const tools = new Map();
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => tools.set(tool.name, tool),
    });
    for (const event of [
      "session_start",
      "session_shutdown",
      "session_compact",
      "session_before_fork",
      "input",
      "before_agent_start",
      "model_select",
      "thinking_level_select",
      "agent_start",
      "turn_start",
      "tool_execution_end",
      "tool_call",
      "after_provider_response",
      "agent_end",
      "agent_settled",
    ]) {
      assert.equal(hooks.has(event), true, `missing ${event}`);
    }
    assert.match(commands.get("route").description, /model-router mode/);
    assert.equal(tools.has("submit_implementation_plan"), true);
    assert.equal(tools.has("submit_action_plan"), true);
    assert.equal(tools.has("submit_safety_review"), true);
  });

  it("renders /route scope from the scoped registry in endpoint selection order", async () => {
    const commands = new Map();
    const notifications = [];
    routerExtension({
      on: () => {},
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
    });
    const makeModel = (provider, id) => ({
      provider,
      id,
      name: id,
      api: "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const models = [makeModel("openai-codex", "gpt-5.6-sol"), makeModel("amazon-bedrock", "openai.gpt-5.6-sol")];
    await commands.get("route").handler("scope", {
      modelRegistry: { getAll: () => models, getAvailable: () => models },
      ui: { notify: (message, type) => notifications.push({ message, type }) },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "info");
    assert.equal(
      notifications[0].message,
      [
        "route scope",
        "patterns (0):",
        "  - source=default pattern=<all registry models>",
        "unmatched patterns (0):",
        "logical models (1):",
        "  gpt-5.6-sol (2 eligible endpoints):",
        "    1. endpoint=amazon-bedrock/openai.gpt-5.6-sol listCost=23.750000 appliedWeight=0.830000 weightBasis=contract weightSource=built-in cacheWrite=priced_write effectiveCost=19.712500",
        "    2. endpoint=openai-codex/gpt-5.6-sol listCost=23.750000 appliedWeight=1.000000 weightBasis=preference weightSource=built-in cacheWrite=priced_write effectiveCost=23.750000",
        "excluded endpoints (0):",
        "provider-weight rejections (0):",
      ].join("\n"),
    );
  });

  it("enriches endpoint-tagged telemetry without changing the event payload", async () => {
    const hooks = new Map();
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-endpoint-telemetry-"));
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const model = {
      provider: "amazon-bedrock",
      id: "openai.gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
    try {
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        appendEntry: () => {},
      });
      await hooks.get("model_select")(
        { source: "user", model },
        {
          modelRegistry: { find: () => model },
          sessionManager: { getSessionId: () => "endpoint-telemetry" },
          ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
        },
      );

      const event = JSON.parse((await readFile(telemetryPath, "utf8")).trim());
      assert.equal(event.kind, "outcome");
      assert.deepEqual(event.data, {
        manualOverride: "model",
        provider: "amazon-bedrock",
        modelId: "openai.gpt-5.6-sol",
      });
      assert.equal(event.endpointEffectiveCost, 19.7125);
      assert.equal(event.appliedProviderWeight, 0.83);
      assert.equal(event.providerWeightBasis, "contract");
      assert.equal(event.cacheWriteClassification, "priced_write");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("uses one scoped registry snapshot for classification and the resulting route decision", async () => {
    const hooks = new Map();
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-shared-snapshot-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousMode = process.env.PI_ROUTER_MODE;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    process.env.PI_ROUTER_MODE = "shadow";
    let activeTools = [];
    let snapshotReads = 0;
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      getActiveTools: () => activeTools,
      getThinkingLevel: () => "high",
      setActiveTools: (tools) => {
        activeTools = tools;
      },
    };
    const ctx = {
      cwd: telemetryDirectory,
      // Defined so builder-provenance resolution also runs; with an undefined model that branch
      // never reads the registry and could not observe a duplicate snapshot build.
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => {
          snapshotReads++;
          return [];
        },
      },
      sessionManager: { getBranch: () => [], getSessionId: () => "shared-snapshot" },
      getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    try {
      routerExtension(pi);
      await hooks.get("input")({ text: "Implement the change", source: "interactive" }, ctx);
      await hooks.get("before_agent_start")(
        { prompt: "Implement the change", systemPrompt: "system", images: [] },
        ctx,
      );
      assert.equal(snapshotReads, 1, "classification, builder provenance, and routing must share one scoped snapshot");
      assert.match(notifications.at(-1)?.message ?? "", /retained current model/i);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("carries routing enablement mode through /clear (session_shutdown → session_start)", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    });

    const lastModePath = join(await mkdtemp(join(tmpdir(), "pi-router-clear-")), "last-mode.jsonl");
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    process.env.PI_ROUTER_LAST_MODE_PATH = lastModePath;

    // The operator enables routing before clearing.
    await commands.get("route").handler("active", {
      sessionManager: { getSessionId: () => "pre-clear" },
      ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
    });
    assert.equal(appended.at(-1).data.mode, "active");

    // Simulate session_shutdown when /clear creates a new session.
    await hooks.get("session_shutdown")({
      type: "session_shutdown",
      reason: "new",
    });

    // After shutdown, session_start is called for the replacement session.
    // The new session has no prior entries (fresh branch).
    const beforeStartPersist = appended.filter((e) => e.customType === "model-router-state").length;

    await hooks.get("session_start")(
      {
        type: "session_start",
        reason: "new",
      },
      {
        cwd: "/repo",
        sessionManager: {
          getSessionId: () => "new-session",
          getBranch: () => [
            // New session has no prior router state; should restore from modeForNextSession.
          ],
        },
        modelRegistry: { getAvailable: () => [], getAll: () => [] },
        model: undefined,
        getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
        ui: {
          setStatus: () => {},
          notify: () => {},
          theme: { fg: (_color, text) => text },
        },
      },
    );

    // Verify that session_start appended a router state entry (the mode was persisted).
    const persistedEntriesAfter = appended.filter((e) => e.customType === "model-router-state");
    assert.equal(
      persistedEntriesAfter.length,
      beforeStartPersist + 1,
      "session_start should persist the restored mode",
    );
    assert.equal(persistedEntriesAfter.at(-1).data.mode, "active", "/clear must not disable active routing");
    assert.equal(persistedEntriesAfter.at(-1).data.active, undefined, "/clear must still drop the task lease");
    const recorded = (await readFile(lastModePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(recorded.at(-1).mode, "active", "the mode in force must be recorded for the next start");
    process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
  });

  it("keeps active routing through /compact while dropping the lease at the boundary", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-compact-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    process.env.PI_ROUTER_LAST_MODE_PATH = join(telemetryDirectory, "last-mode.jsonl");
    try {
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: (name, command) => commands.set(name, command),
        registerTool: () => {},
        appendEntry: (customType, data) => appended.push({ customType, data }),
      });
      const ctx = {
        sessionManager: { getSessionId: () => "compacting" },
        ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
      };
      await commands.get("route").handler("active", ctx);

      await hooks.get("session_compact")({ type: "session_compact" }, ctx);

      const persisted = appended.filter((entry) => entry.customType === "model-router-state");
      assert.equal(persisted.at(-1).data.mode, "active", "/compact must not disable active routing");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      process.env.PI_ROUTER_LAST_MODE_PATH = previousLastModePath;
    }
  });

  it("reads startMode from config file when env var is not set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;

    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;

      // Write config file with startMode = active
      await writeFile(join(tempDir, "router-config.json"), JSON.stringify({ startMode: "active" }));

      const hooks = new Map();
      const appended = [];
      routerExtension({
        on: (event, handler) => hooks.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        appendEntry: (customType, data) => appended.push({ customType, data }),
      });

      // Simulate startup with no prior state — should load from config
      await hooks.get("session_start")(
        {
          type: "session_start",
          reason: "startup",
        },
        {
          cwd: "/repo",
          sessionManager: {
            getSessionId: () => "startup-session",
            getBranch: () => [],
          },
          modelRegistry: { getAvailable: () => [], getAll: () => [] },
          model: undefined,
          getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
          ui: {
            setStatus: () => {},
            notify: () => {},
            theme: { fg: (_color, text) => text },
          },
        },
      );

      // Verify state was set to active from config
      const entries = appended.filter((e) => e.customType === "model-router-state");
      assert.ok(entries.length > 0, "should persist router state from config");
      assert.equal(entries[entries.length - 1].data.mode, "active", "should use startMode from config file");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("starts in the last recorded mode by default so enablement survives a restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-last-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;
      process.env.PI_ROUTER_LAST_MODE_PATH = join(tempDir, "router-last-mode.jsonl");
      // No router-config.json: the built-in preference is the last recorded mode.
      await writeFile(
        process.env.PI_ROUTER_LAST_MODE_PATH,
        `${JSON.stringify({ version: 1, mode: "active", updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      );

      const entries = await startupRouterState();
      assert.equal(entries.at(-1)?.data.mode, "active", "startup should restore the recorded exit mode");
    } finally {
      restoreEnv({ previousAgentDir, previousMode, previousLastModePath });
    }
  });

  it("lets a repository-scoped startMode override the global one", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-router-repo-scope-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMode = process.env.PI_ROUTER_MODE;
    const previousLastModePath = process.env.PI_ROUTER_LAST_MODE_PATH;
    try {
      process.env.PI_CODING_AGENT_DIR = tempDir;
      delete process.env.PI_ROUTER_MODE;
      process.env.PI_ROUTER_LAST_MODE_PATH = join(tempDir, "router-last-mode.jsonl");
      await writeFile(join(tempDir, "router-config.json"), JSON.stringify({ startMode: "off" }));
      await writeFile(
        join(tempDir, "repo-router-config.json"),
        JSON.stringify({
          "github.com:nigel-upstart/pi-buildout": { startMode: "active" },
          "github.com:other/repo": { startMode: "off" },
        }),
      );

      const entries = await startupRouterState({
        exec: (_command, args) => {
          const gitArgs = args.slice(2);
          if (gitArgs[0] === "remote" && gitArgs[1] === "get-url" && gitArgs[2] === "upstream") {
            return Promise.resolve({ code: 0, stdout: "git@github.com:nigel-upstart/pi-buildout.git\n", stderr: "" });
          }
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        },
      });
      assert.equal(entries.at(-1)?.data.mode, "active", "the repository entry should win over the global file");
    } finally {
      restoreEnv({ previousAgentDir, previousMode, previousLastModePath });
    }
  });

  it("acknowledges input immediately and shows the routing spinner before repository I/O finishes", async () => {
    const hooks = new Map();
    const workingMessages = [];
    const visibility = [];
    const never = new Promise(() => {});
    let activeTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    routerExtension({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      exec: () => never,
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
    });
    const result = await hooks.get("input")(
      { text: "New task", source: "interactive" },
      {
        cwd: "/repo",
        sessionManager: { getBranch: () => [] },
        ui: {
          setWorkingMessage: (message) => workingMessages.push(message),
          setWorkingVisible: (visible) => visibility.push(visible),
        },
      },
    );
    assert.deepEqual(result, { action: "continue" });
    assert.deepEqual(workingMessages, ["Routing..."]);
    assert.deepEqual(visibility, [true]);
    assert.deepEqual(activeTools, ["read", "bash"], "lease-scoped validators are hidden before classification");
  });

  it("fails active mode back to shadow when the audit log cannot append", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-telemetry-failure-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    const previousMode = process.env.PI_ROUTER_MODE;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryDirectory;
    process.env.PI_ROUTER_MODE = "active";
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    };
    routerExtension(pi);
    const ctx = {
      sessionManager: { getSessionId: () => "telemetry-failure" },
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    try {
      await hooks.get("model_select")({ source: "set", model: { provider: "openai-codex", id: "gpt-5.6-terra" } }, ctx);
      assert.equal(appended.at(-1).data.mode, "shadow");
      assert.match(notifications.at(-1).message, /telemetry failed/i);
      await commands.get("route").handler("active", ctx);
      assert.match(notifications.at(-1).message, /cannot enter active mode/i);
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
      if (previousMode === undefined) delete process.env.PI_ROUTER_MODE;
      else process.env.PI_ROUTER_MODE = previousMode;
    }
  });

  it("retains one evidence entry per deterministic check command", async () => {
    const hooks = new Map();
    const appended = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-check-evidence-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const choice = {
      provider: "openai",
      modelId: "gpt-5.6-terra",
      logicalModelId: "gpt-5.6-terra",
      vendor: "openai",
      effort: "high",
      ability: 2,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "bootstrap",
    };
    const lease = {
      version: 2,
      taskId: "check-evidence-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("check evidence retention test"),
      selected: choice,
      fallbacks: [{ ...choice, provider: "openai-codex" }],
      attemptIndex: 0,
      promptProfileId: choice.profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "building", policy: "completion_review", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: () => {},
      setModel: async () => true,
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: undefined,
      modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
      sessionManager: { getBranch: () => branch, getSessionId: () => "check-evidence-session" },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
    };
    const latestChecks = () =>
      appended.findLast((entry) => entry.customType === "model-router-state")?.data.active.safetyEvidence.checks;
    const runCheck = (toolCallId, command, isError) => {
      hooks.get("tool_call")({ toolCallId, toolName: "bash", input: { command } });
      hooks.get("tool_execution_end")({ toolCallId, toolName: "bash", isError });
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      runCheck("call-1", "npm test", true);
      runCheck("call-2", "npm run lint", false);
      runCheck("call-3", "npm test", false);
      assert.deepEqual(
        latestChecks().map((check) => [check.command, check.passed]),
        [
          ["npm run lint", true],
          ["npm test", true],
        ],
        "each command keeps exactly its latest outcome",
      );

      for (let index = 0; index < 25; index++) {
        runCheck(`flood-${String(index)}`, `npm test -- shard${String(index)}`, false);
      }
      assert.equal(latestChecks().length, 20, "retention stays bounded");

      for (let index = 0; index < 25; index++) runCheck(`repeat-${String(index)}`, "npm run lint", index === 24);
      const repeated = latestChecks().filter((check) => check.command === "npm run lint");
      assert.deepEqual(
        repeated.map((check) => check.passed),
        [false],
        "a repeated command keeps exactly one entry and retains its unresolved failure",
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("repairs one missing planning validation before fallback and reports exhaustion once", async () => {
    const hooks = new Map();
    const commands = new Map();
    const appended = [];
    const sent = [];
    const selectedModels = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-plan-repair-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const primaryChoice = {
      provider: "anthropic",
      modelId: "claude-opus-5",
      logicalModelId: "claude-opus-5",
      vendor: "anthropic",
      effort: "high",
      ability: 4,
      profileId: "anthropic-claude-planning-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "evidence_prior",
    };
    const fallbackChoice = {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      logicalModelId: "gpt-5.6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 1_000_000,
      endpointTier: "manufacturer",
      rankReason: "evidence_prior",
    };
    const lease = {
      version: 2,
      taskId: "planning-task",
      startedAt: now,
      updatedAt: now,
      archetype: "implementation_planning",
      features: conservativeFeatures("planning validation repair test"),
      selected: primaryChoice,
      fallbacks: [fallbackChoice],
      attemptIndex: 0,
      promptProfileId: primaryChoice.profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const makeModel = (choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      name: choice.modelId,
      api: choice.vendor === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: choice.contextWindow,
      maxTokens: 128_000,
    });
    const models = [makeModel(primaryChoice), makeModel(fallbackChoice)];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: (message, options) => sent.push({ message, options }),
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "plan-repair-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    const completeRun = async (model) => {
      ctx.model = model;
      hooks.get("agent_start")();
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: model.provider,
              model: model.id,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        ctx,
      );
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);

      await completeRun(models[0]);
      assert.equal(latestLease().attemptIndex, 0, "contract repair must not consume the fallback");
      assert.equal(latestLease().planValidationRepairAttempted, true);
      assert.match(sent[0].message.content, /submit_implementation_plan/);
      assert.equal(sent[0].message.details.repairReason, "missing_plan_validation");
      assert.equal(selectedModels.length, 0);

      await completeRun(models[0]);
      assert.equal(latestLease().attemptIndex, 1, "a repeated omission must use the existing fallback");
      assert.equal(latestLease().selected.modelId, fallbackChoice.modelId);
      assert.equal(selectedModels[0].id, fallbackChoice.modelId);
      assert.match(sent[1].message.content, /previous routed attempt failed/i);

      await completeRun(models[1]);
      assert.equal(latestLease().executionFailed, true);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /all authorized ordinary provider choices exhausted/);

      await completeRun(models[1]);
      await commands.get("route").handler("fail deterministic_verification", ctx);
      assert.equal(notifications.length, 1, "an exhausted lease must not repeat its error notification");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("moves a persisted Bedrock Sol lease off an endpoint with no long-context price", async () => {
    const hooks = new Map();
    const appended = [];
    const selectedModels = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-long-context-lease-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "amazon-bedrock",
        modelId: "global.openai.gpt-5.6-sol",
        logicalModelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "high",
        ability: 3,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "resale",
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        logicalModelId: "claude-sonnet-5",
        vendor: "anthropic",
        effort: "high",
        ability: 3,
        profileId: "anthropic-claude-fast-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
    ];
    const lease = {
      version: 2,
      taskId: "long-context-lease-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("long-context lease test"),
      selected: choices[0],
      fallbacks: choices.slice(1),
      attemptIndex: 0,
      promptProfileId: choices[0].profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const models = choices.map((choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      name: choice.modelId,
      api: choice.vendor === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: choice.contextWindow,
      maxTokens: 128_000,
    }));
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: () => {},
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      getActiveTools: () => [],
      setActiveTools: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: { getBranch: () => branch, getSessionId: () => "long-context-lease-session" },
      getContextUsage: () => ({ tokens: 272_001, contextWindow: 1_000_000, percent: 28 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: () => {},
      },
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("before_agent_start")({ prompt: "Continue the task", systemPrompt: "base" }, ctx);
      const latestLease = appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
      assert.equal(latestLease.selected.provider, "anthropic");
      assert.equal(latestLease.attemptIndex, 1);
      assert.ok(selectedModels.length > 0);
      assert.ok(selectedModels.every((model) => model.provider === "anthropic"));
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("tries every leased provider after an invalidated OpenAI Codex token", async () => {
    const hooks = new Map();
    const appended = [];
    const selectedModels = [];
    const notifications = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-auth-failover-"));
    const telemetryPath = join(telemetryDirectory, "events.jsonl");
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = telemetryPath;
    const now = new Date().toISOString();
    const choices = [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        logicalModelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "openai",
        modelId: "gpt-5.6-terra",
        logicalModelId: "gpt-5.6-terra",
        vendor: "openai",
        effort: "high",
        ability: 2,
        profileId: "openai-gpt-5.6-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
      {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        logicalModelId: "claude-sonnet-5",
        vendor: "anthropic",
        effort: "high",
        ability: 3,
        profileId: "anthropic-claude-fast-agent-v1",
        contextWindow: 1_000_000,
        endpointTier: "manufacturer",
        rankReason: "bootstrap",
      },
    ];
    const lease = {
      version: 2,
      taskId: "auth-failover-task",
      startedAt: now,
      updatedAt: now,
      archetype: "median_repository_implementation",
      features: conservativeFeatures("authentication failover test"),
      selected: choices[0],
      fallbacks: choices.slice(1),
      attemptIndex: 0,
      promptProfileId: choices[0].profileId,
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "ordinary", policy: "ordinary", taskFingerprint: "task-fingerprint" },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    const makeModel = (choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      name: choice.modelId,
      api: choice.vendor === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: choice.contextWindow,
      maxTokens: 128_000,
    });
    const models = choices.map(makeModel);
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: lease },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: () => {},
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "auth-failover-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    const failForInvalidToken = async (model) => {
      ctx.model = model;
      hooks.get("agent_start")();
      hooks.get("after_provider_response")({ status: 401 });
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: model.provider,
              model: model.id,
              stopReason: "error",
              usage: { input: 100, output: 0, cacheRead: 25, cacheWrite: 10, cost: { total: 0 } },
            },
          ],
        },
        ctx,
      );
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await failForInvalidToken(models[0]);
      assert.equal(latestLease().selected.provider, "openai");
      assert.equal(latestLease().attemptIndex, 1);
      await failForInvalidToken(models[1]);
      assert.equal(latestLease().selected.provider, "anthropic");
      assert.equal(latestLease().attemptIndex, 2);
      await failForInvalidToken(models[2]);
      assert.equal(latestLease().executionFailed, true);
      assert.deepEqual(
        selectedModels.map((model) => model.provider),
        ["openai", "anthropic"],
      );
      assert.match(notifications[0].message, /all authorized ordinary provider choices exhausted/);
      const attempts = (await readFile(telemetryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.kind === "attempt_completed");
      assert.deepEqual(
        attempts.map((event) => [event.provider, event.data.cacheReadTokens, event.data.cacheWriteTokens]),
        [
          ["openai-codex", 25, 10],
          ["openai", 25, 10],
          ["anthropic", 25, 10],
        ],
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("authorizes only an approved exact irreversible-action plan and invalidates it on user input", async () => {
    const hooks = new Map();
    const tools = new Map();
    const appended = [];
    const sent = [];
    const selectedModels = [];
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-authorization-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const features = {
      ...conservativeFeatures("authorization lifecycle test"),
      intent: "operate",
      workflowType: "incident_or_operations",
      actionMode: "destructive",
      risk: "critical",
      confidence: 0.99,
    };
    const parent = {
      version: 2,
      taskId: "irreversible-parent",
      startedAt: now,
      updatedAt: now,
      archetype: "highest_risk_advisory",
      features,
      selected: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        logicalModelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "high",
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
          ability: 4,
          profileId: "anthropic-claude-planning-v1",
          contextWindow: 1_000_000,
          endpointTier: "manufacturer",
          rankReason: "evidence_prior",
        },
      ],
      attemptIndex: 0,
      promptProfileId: "openai-gpt-5.6-agent-v1",
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: {
        phase: "preflight",
        policy: "authorization_then_completion_review",
        taskFingerprint: "task-fingerprint",
      },
      safetyEvidence: { baselineChangedFiles: [], checks: [], mutations: [] },
      manualOverride: false,
    };
    let activeTools = ["read", "bash", "submit_action_plan", "submit_safety_review"];
    const makeModel = (provider, id, api) => ({
      provider,
      id,
      name: id,
      api,
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const models = [
      makeModel("openai-codex", "gpt-5.6-sol", "openai-responses"),
      makeModel("anthropic", "claude-opus-5", "anthropic-messages"),
      makeModel("google-vertex", "gemini-3.6-flash", "google-generative-ai"),
    ];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: parent },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: (tool) => tools.set(tool.name, tool),
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: (message, options) => sent.push({ message, options }),
      setModel: async (model) => {
        selectedModels.push(model);
        return true;
      },
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      getActiveTools: () => activeTools,
      setActiveTools: (tools) => {
        activeTools = tools;
      },
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "authorization-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        notify: () => {},
      },
    };
    const latestLease = () => appended.findLast((entry) => entry.customType === "model-router-state")?.data.active;
    const completeReview = async (child, verdict) => {
      ctx.model = models.find(
        (model) => model.provider === child.selected.provider && model.id === child.selected.modelId,
      );
      const reviewStart = await hooks.get("before_agent_start")(
        { prompt: "Perform the generated review", systemPrompt: "base" },
        ctx,
      );
      assert.match(reviewStart.systemPrompt, /read-only authorization review/);
      assert.deepEqual(activeTools, ["read", "bash", "submit_safety_review"]);
      hooks.get("agent_start")();
      await tools.get("submit_safety_review").execute(
        `review-${verdict}`,
        {
          reviewKind: "authorization",
          scopeFingerprint: child.lifecycle.scopeFingerprint,
          verdict,
          summary: verdict === "approve" ? "The exact plan is bounded." : "Rollback is not yet credible.",
          evidence: ["Checked targets, preconditions, irreversible effects, and abort conditions."],
          findings: verdict === "approve" ? [] : ["Strengthen rollback verification."],
        },
        undefined,
        undefined,
        ctx,
      );
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: child.selected.provider,
              model: child.selected.modelId,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        ctx,
      );
      await hooks.get("agent_settled")({}, ctx);
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      const preflightStart = await hooks.get("before_agent_start")(
        { prompt: "Inspect and plan the production change", systemPrompt: "base" },
        ctx,
      );
      assert.match(preflightStart.systemPrompt, /Safety lifecycle: remain non-mutating/);
      assert.deepEqual(activeTools, ["read", "bash", "submit_action_plan"]);
      assert.match(
        hooks.get("tool_call")({ toolName: "bash", input: { command: "deploy production" } }).reason,
        /preflight/,
      );
      await tools.get("submit_action_plan").execute("plan", irreversibleActionPlan(), undefined, undefined, ctx);
      await hooks.get("agent_settled")({}, ctx);
      const rejectedChild = latestLease();
      assert.equal(rejectedChild.lifecycle.reviewKind, "authorization");
      await completeReview(rejectedChild, "reject");
      assert.equal(latestLease().lifecycle.phase, "preflight");
      assert.equal(sent.length, 1, "rejection must not send an execution continuation");

      ctx.model = models[0];
      await hooks.get("agent_settled")({}, ctx);
      const approvedChild = latestLease();
      assert.notEqual(
        approvedChild.selected.vendor,
        parent.selected.vendor,
        "an authorization review must not be routed to the builder's vendor",
      );
      await completeReview(approvedChild, "approve");
      assert.equal(latestLease().lifecycle.phase, "authorized_execution");
      assert.equal(latestLease().lifecycle.authorization.planFingerprint, latestLease().lifecycle.plan.planFingerprint);
      assert.equal(latestLease().lifecycle.authorization.reviewerVendor, approvedChild.selected.vendor);
      assert.notEqual(
        latestLease().lifecycle.authorization.reviewerVendor,
        parent.selected.vendor,
        "the recorded authorization must name an independent reviewer vendor",
      );
      assert.equal(sent.length, 3, "approval adds the second review request and one execution continuation");
      assert.equal(hooks.get("tool_call")({ toolName: "bash", input: { command: "deploy production" } }), undefined);
      assert.match(hooks.get("tool_call")({ toolName: "custom_mutator", input: {} }).reason, /outside/);

      await hooks.get("input")({ text: "Change the target and continue", source: "interactive" }, ctx);
      assert.deepEqual(activeTools, ["read", "bash"]);
      assert.equal(latestLease().lifecycle.phase, "preflight");
      assert.match(
        hooks.get("tool_call")({ toolName: "bash", input: { command: "deploy production" } }).reason,
        /preflight/,
      );
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });

  it("runs a required completion review as a read-only child lease and restores the builder", async () => {
    const hooks = new Map();
    const appended = [];
    const sent = [];
    const selectedModels = [];
    const tools = new Map();
    const telemetryDirectory = await mkdtemp(join(tmpdir(), "pi-router-adapter-"));
    const previousTelemetryPath = process.env.PI_ROUTER_TELEMETRY_PATH;
    process.env.PI_ROUTER_TELEMETRY_PATH = join(telemetryDirectory, "events.jsonl");
    const now = new Date().toISOString();
    const features = {
      ...conservativeFeatures("required review test"),
      intent: "implement",
      workflowType: "coding_implementation",
      actionMode: "reversible_mutation",
      risk: "critical",
      confidence: 0.99,
    };
    const parent = {
      version: 2,
      taskId: "parent-task",
      startedAt: now,
      updatedAt: now,
      archetype: "highest_risk_advisory",
      features,
      selected: {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        logicalModelId: "gpt-5.6-sol",
        vendor: "openai",
        effort: "high",
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
          ability: 4,
          profileId: "anthropic-claude-planning-v1",
          contextWindow: 1_000_000,
          endpointTier: "manufacturer",
          rankReason: "evidence_prior",
        },
      ],
      attemptIndex: 0,
      promptProfileId: "openai-gpt-5.6-agent-v1",
      modelSnapshotId: "snapshot",
      policyVersion: POLICY_VERSION,
      lastPromptFingerprint: "fingerprint",
      lifecycle: { phase: "building", policy: "completion_review", taskFingerprint: "task-fingerprint" },
      safetyEvidence: {
        baselineHead: "base-head",
        baselineChangedFiles: [],
        checks: [{ command: "npm test", passed: true, recordedAt: now }],
        mutations: [{ toolName: "edit", inputFingerprint: "e".repeat(64), recordedAt: now }],
      },
      manualOverride: false,
    };
    const makeModel = (provider, id, api) => ({
      provider,
      id,
      name: id,
      api,
      baseUrl: "https://models.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const models = [
      makeModel("openai-codex", "gpt-5.6-sol", "openai-responses"),
      makeModel("anthropic", "claude-opus-5", "anthropic-messages"),
      makeModel("google-vertex", "gemini-3.6-flash", "google-generative-ai"),
    ];
    const branch = [
      {
        type: "custom",
        customType: "model-router-state",
        data: { mode: "active", manualOverride: false, active: parent },
      },
    ];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      registerCommand: () => {},
      registerTool: (tool) => tools.set(tool.name, tool),
      appendEntry: (customType, data) => appended.push({ customType, data }),
      sendMessage: (message, options) => sent.push({ message, options }),
      setModel: async (model) => selectedModels.push(model),
      setThinkingLevel: () => {},
      getThinkingLevel: () => "high",
      exec: async (command, args) => {
        const joined = args?.join(" ") ?? "";
        if (command === "git" && joined.includes("rev-parse --show-toplevel")) {
          return { stdout: `${telemetryDirectory}\n`, stderr: "", code: 0, killed: false };
        }
        if (command === "git" && joined.includes("rev-parse HEAD")) {
          return { stdout: "completed-head\n", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && joined.includes("status --porcelain")) {
          return { stdout: " M src/a.ts\n", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && joined.includes("ls-files")) {
          return { stdout: "src/a.ts\n", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && joined.includes("diff --no-ext-diff --binary")) {
          return { stdout: "diff --git a/src/a.ts b/src/a.ts\n+safe change\n", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    };
    routerExtension(pi);
    const ctx = {
      cwd: telemetryDirectory,
      model: models[0],
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "review-session",
      },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus: () => {},
        notify: () => {},
      },
    };
    try {
      await hooks.get("session_start")({ reason: "reload" }, ctx);
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].options.triggerTurn, true);
      const child = appended.at(-1).data.active;
      assert.equal(child.parentTaskId, parent.taskId);
      assert.equal(child.lifecycle.phase, "review");
      assert.equal(child.lifecycle.reviewKind, "completion");
      assert.equal(child.archetype, "code_review");
      assert.notEqual(child.selected.vendor, "openai");
      assert.match(hooks.get("tool_call")({ toolName: "edit", input: {} }).reason, /read-only/);
      assert.equal(hooks.get("tool_call")({ toolName: "bash", input: { command: "git diff --stat" } }), undefined);
      assert.match(
        hooks.get("tool_call")({ toolName: "bash", input: { command: "git diff | sh" } }).reason,
        /read-only/,
      );
      assert.match(hooks.get("tool_call")({ toolName: "custom_mutator", input: {} }).reason, /read-only/);
      await hooks.get("agent_settled")({}, ctx);
      assert.equal(appended.at(-1).data.active.taskId, child.taskId, "pending review must not restore its parent");
      ctx.model = selectedModels[0];
      hooks.get("agent_start")();
      hooks.get("turn_start")();
      await tools.get("submit_safety_review").execute(
        "review-tool-call",
        {
          reviewKind: "completion",
          scopeFingerprint: child.lifecycle.scopeFingerprint,
          verdict: "pass",
          summary: "The implementation and passing check match the tracked task.",
          evidence: ["Inspected the baseline-to-working-tree diff and npm test evidence."],
          findings: [],
        },
        undefined,
        undefined,
        ctx,
      );
      await hooks.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              provider: child.selected.provider,
              model: child.selected.modelId,
              stopReason: "stop",
              usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0.01 } },
            },
          ],
        },
        ctx,
      );
      await hooks.get("agent_settled")({}, ctx);
      const restored = appended.at(-1).data.active;
      assert.equal(restored.taskId, parent.taskId);
      assert.equal(restored.lifecycle.phase, "completed");
      assert.equal(restored.lifecycle.completionReview.verdict, "pass");
      assert.equal(restored.selected.modelId, "gpt-5.6-sol");
      // The reviewer is the Anthropic rung at or above the builder's evidence band.
      assert.equal(selectedModels[0].id, "claude-opus-5");
    } finally {
      if (previousTelemetryPath === undefined) delete process.env.PI_ROUTER_TELEMETRY_PATH;
      else process.env.PI_ROUTER_TELEMETRY_PATH = previousTelemetryPath;
    }
  });
});
