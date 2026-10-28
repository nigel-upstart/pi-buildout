import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createBuilderReviewRunner } from "./builder-runner.ts";
import { bindPlan, createDiscovery, createQuarantine, planFromAnswer } from "./discovery.ts";

/** Released tintinweb 0.22.0 `Agent` parameter shape, including its published `isolated` documentation. */
function agentTool(overrides = {}) {
  return {
    name: "Agent",
    description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
    promptGuidelines: [],
    exposure: "direct",
    sourceInfo: { path: "/ext/pi-subagents/index.ts", source: "npm", scope: "user", origin: "package" },
    active: true,
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      subagent_type: Type.String(),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      isolated: Type.Optional(
        Type.Boolean({ description: "If true, agent gets no extension/MCP tools — only built-in tools." }),
      ),
      inherit_context: Type.Optional(Type.Boolean()),
    }),
    ...overrides,
  };
}
const agentAnswer = (overrides = {}) => ({
  match: true,
  spawnTool: "Agent",
  spawnArguments: [
    { path: "prompt", bind: "task" },
    { path: "description", literal: '"router review"' },
    { path: "subagent_type", literal: '"general-purpose"' },
    { path: "model", bind: "model" },
    { path: "thinking", bind: "effort" },
    { path: "run_in_background", literal: "false" },
    { path: "isolated", literal: "true" },
    { path: "inherit_context", literal: "false" },
  ],
  isolationArgument: "isolated",
  isolationEvidence: "If true, agent gets no extension/MCP tools",
  ...overrides,
});
const other = (name, description = "Unrelated") => ({
  ...agentTool(),
  name,
  description,
  sourceInfo: { path: `/ext/${name}.ts`, source: "local", scope: "project", origin: "top-level" },
  parameters: Type.Object({ path: Type.String() }),
});
const values = { task: "TASK", model: "anthropic/claude-opus-5-5", effort: "high" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(initial, options = {}) {
  let tools = initial;
  const calls = [];
  const events = [];
  const discovery = createDiscovery({
    tools: () => tools,
    excluded: options.excluded ?? (() => false),
    classify: (input, signal) => {
      const call = { tools: input, signal, ...deferred() };
      calls.push(call);
      return call.promise;
    },
    onEvent: (event) => events.push(event),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { discovery, calls, events, setTools: (next) => (tools = next) };
}

test("first access starts one background refresh; concurrent accesses share it", async () => {
  const h = harness([agentTool()]);
  assert.equal(h.discovery.observe(), undefined, "no publication yet: the review uses SDK, never waits");
  assert.equal(h.discovery.observe(), undefined);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.equal(h.discovery.observe().plan.spawnTool, "Agent");
  assert.equal(h.calls.length, 1, "a clean publication does not refresh");
});

test("old match and old none stay visible during refresh; newest generation wins", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.calls[0].resolve({ match: false });
  await tick();
  assert.equal(h.discovery.observe().plan, null, "a successful no-match is published");
  h.setTools([agentTool(), other("grep2")]);
  assert.equal(h.discovery.observe().plan, null, "none remains visible while refreshing");
  h.calls[1].resolve(agentAnswer());
  await tick();
  const published = h.discovery.observe();
  assert.equal(published.plan.spawnTool, "Agent");
  h.setTools([agentTool(), other("grep3")]);
  assert.equal(h.discovery.observe(), published, "an old match also stays visible during refresh");
  h.calls[2].resolve({ match: false });
  await tick();
});

test("a tool change aborts the prior flight; an ignored abort cannot publish", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.setTools([agentTool(), other("late")]);
  h.discovery.observe();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 1, "an ignored abort still occupies the single flight slot");
  h.setTools([agentTool(), other("newest")]);
  h.discovery.observe();
  assert.equal(h.calls.length, 1, "further tool changes cannot overlap the old request");
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.equal(h.discovery.observe(), undefined, "the superseded flight ignored abort but cannot publish");
  assert.equal(h.calls.length, 2, "the next access refreshes only after settlement");
  assert.equal(h.calls[1].tools.at(-1).name, "newest");
  h.calls[1].resolve({ match: false });
  await tick();
  assert.equal(h.discovery.observe().plan, null);
});

test("timeout aborts, records telemetry, stays DIRTY, and retries only on next access", async () => {
  const h = harness([agentTool()], { timeoutMs: 10 });
  h.discovery.observe();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.calls[0].signal.aborted, true);
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ["timeout"],
  );
  assert.equal(h.calls.length, 1, "no timer or catch/finally retry");
  h.discovery.observe();
  assert.equal(h.calls.length, 1, "ignored timeout abort cannot open another flight");
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.equal(h.calls.length, 1, "settlement itself does not eagerly retry");
  assert.equal(h.discovery.observe(), undefined, "the timed-out flight cannot publish later");
  assert.equal(h.calls.length, 2, "the next access retries once after settlement");
  h.setTools([agentTool(), other("x")]);
  h.discovery.observe();
  assert.equal(h.calls[1].signal.aborted, true, "a tool change cancels the retry too");
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(agentAnswer());
  await tick();
  h.discovery.observe();
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve({ match: false });
  await tick();
});

test("session reset drops the publication while an ignored abort retains the single-flight bound", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.ok(h.discovery.observe().plan);
  h.setTools([agentTool(), other("changed")]);
  h.discovery.observe();
  h.discovery.reset();
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.discovery.observe(), undefined, "new sessions never inherit the previous publication");
  assert.equal(h.calls.length, 2, "reset cannot overlap a provider that ignored abort");
  h.calls[1].resolve(agentAnswer());
  await tick();
  assert.equal(h.calls.length, 2, "settlement never eagerly retries");
  assert.equal(h.discovery.observe(), undefined);
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve({ match: false });
  await tick();
  assert.equal(h.discovery.observe().plan, null);
});

test("failures do not publish; the next access retries", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.calls[0].resolve({ match: true, spawnTool: "Agent" });
  await tick();
  assert.equal(h.discovery.observe(), undefined);
  assert.equal(h.calls.length, 2);
  assert.equal(h.events[0].kind, "failed");
  h.calls[1].resolve({ match: false });
  await tick();
});

test("isolation needs verbatim published documentation, not a field name or model claim", () => {
  const tools = [agentTool()];
  assert.ok(planFromAnswer(agentAnswer(), tools));
  assert.equal(planFromAnswer(agentAnswer({ isolationEvidence: "agent gets no router" }), tools), undefined);
  const undocumented = agentTool({
    parameters: Type.Object({
      prompt: Type.String(),
      model: Type.String(),
      effort: Type.String(),
      isolated: Type.Boolean(),
    }),
  });
  const named = agentAnswer({
    spawnArguments: [
      { path: "prompt", bind: "task" },
      { path: "model", bind: "model" },
      { path: "effort", bind: "effort" },
      { path: "isolated", literal: "true" },
    ],
    isolationEvidence: "isolated: no extensions are loaded",
  });
  assert.equal(planFromAnswer(named, [undocumented]), undefined, "a field named isolated proves nothing");
  // Our own normal tool's fresh context excludes conversation only, not extensions.
  const contextOnly = agentTool({
    parameters: Type.Object({
      task: Type.String(),
      contextMode: Type.Optional(Type.String({ description: "none sends no parent conversation context" })),
    }),
  });
  assert.equal(
    planFromAnswer(
      agentAnswer({ isolationArgument: "contextMode", isolationEvidence: "none sends no parent conversation" }),
      [contextOnly],
    ),
    undefined,
  );
});

test("the isolation literal must be the documented value, once, with no overlapping paths", () => {
  const tools = [agentTool()];
  const withArgs = (spawnArguments) => agentAnswer({ spawnArguments });
  const base = agentAnswer().spawnArguments;
  assert.equal(
    planFromAnswer(
      withArgs(base.map((entry) => (entry.path === "isolated" ? { ...entry, literal: "false" } : entry))),
      tools,
    ),
    undefined,
    "the documentation says true; false loads extensions",
  );
  assert.equal(
    planFromAnswer(withArgs([...base, { path: "isolated", literal: "false" }]), tools),
    undefined,
    "a later duplicate cannot override the checked literal",
  );
  const plan = planFromAnswer(agentAnswer(), tools);
  const overlapping = { ...plan, spawnArguments: [...plan.spawnArguments, { path: "description.x", literal: "1" }] };
  assert.doesNotThrow(() => bindPlan(overlapping, tools, values));
  assert.equal(bindPlan(overlapping, tools, values), undefined);
});

test("binding uses parent values and Pi validation; rejects invented, missing, or invalid arguments", () => {
  const tools = [agentTool()];
  const plan = planFromAnswer(agentAnswer(), tools);
  const call = bindPlan(plan, tools, values);
  assert.deepEqual(call.arguments, {
    prompt: "TASK",
    description: "router review",
    subagent_type: "general-purpose",
    model: "anthropic/claude-opus-5-5",
    thinking: "high",
    run_in_background: false,
    isolated: true,
    inherit_context: false,
  });
  const variant = (spawnArguments) => bindPlan({ ...plan, spawnArguments }, tools, values);
  assert.equal(variant([...plan.spawnArguments, { path: "sandbox", literal: "true" }]), undefined, "invented");
  assert.equal(
    variant(plan.spawnArguments.filter((entry) => entry.path !== "subagent_type")),
    undefined,
    "required field missing",
  );
  assert.equal(
    variant(plan.spawnArguments.map((entry) => (entry.path === "isolated" ? { ...entry, literal: '"yes"' } : entry))),
    undefined,
    "invalid type",
  );
  assert.equal(
    variant(plan.spawnArguments.filter((entry) => entry.path !== "thinking")),
    undefined,
    "effort must be bound",
  );
  assert.equal(
    variant(plan.spawnArguments.map((entry) => (entry.path === "model" ? { path: "model", literal: '"x/y"' } : entry))),
    undefined,
    "the plan cannot choose the model",
  );
  assert.equal(bindPlan(plan, [agentTool({ active: false })], values), undefined, "not callable now");
  assert.equal(bindPlan(plan, [other("Other")], values), undefined, "disappeared");
  assert.equal(bindPlan(plan, [agentTool({ exposure: "deferred" })], values), undefined);
});

test("quarantine is candidate-specific, survives unrelated changes, and clears only on contract change", () => {
  const quarantine = createQuarantine(2);
  const tools = [agentTool(), other("grep2")];
  const call = bindPlan(planFromAnswer(agentAnswer(), tools), tools, values);
  assert.equal(quarantine.blocks(agentTool(), tools), false);
  quarantine.add(call, "argument_rejected");
  assert.equal(quarantine.blocks(agentTool(), [agentTool(), other("grep3")]), true, "unrelated change");
  assert.equal(quarantine.blocks(agentTool({ description: "Reworded help" }), tools), true, "cosmetic docs");
  assert.equal(quarantine.blocks(agentTool(), tools), true, "disappearance and reappearance retain evidence");
  const changed = agentTool({ parameters: Type.Object({ prompt: Type.String(), model: Type.String() }) });
  assert.equal(quarantine.blocks(changed, [changed]), false, "a meaningful schema change clears it");
  assert.equal(quarantine.blocks(agentTool(), tools), false);
});

test("a full quarantine map blocks every candidate instead of evicting evidence", () => {
  const quarantine = createQuarantine(1);
  const tools = [agentTool()];
  const call = bindPlan(planFromAnswer(agentAnswer(), tools), tools, values);
  quarantine.add(call, "argument_rejected");
  const second = { ...call, tool: other("Second") };
  quarantine.add(second, "argument_rejected");
  assert.equal(quarantine.blocks(other("Third"), tools), true);
  assert.equal(quarantine.blocks(agentTool(), tools), true);
  quarantine.reset();
  assert.equal(quarantine.blocks(agentTool(), tools), false, "session replacement clears contract evidence");
  assert.equal(quarantine.blocks(other("Third"), tools), false, "session replacement clears overflow too");
});

test("quarantine excludes the candidate from discovery and old generations cannot republish it", async () => {
  const quarantine = createQuarantine();
  const tools = [agentTool()];
  const h = harness(tools, { excluded: (tool, all) => quarantine.blocks(tool, all) });
  h.discovery.observe();
  h.calls[0].resolve(agentAnswer());
  await tick();
  h.setTools([...tools, other("grep2")]);
  h.discovery.observe();
  quarantine.add(bindPlan(planFromAnswer(agentAnswer(), tools), tools, values), "argument_rejected");
  h.discovery.invalidate();
  assert.equal(h.calls[1].signal.aborted, true, "quarantine advances generation and aborts the flight");
  assert.equal(h.calls.length, 2, "no eager refresh");
  h.calls[1].resolve(agentAnswer());
  await tick();
  h.discovery.observe();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(
    h.calls[2].tools.map((tool) => tool.name),
    ["grep2"],
    "the quarantined contract is excluded from classifier input",
  );
  h.calls[2].resolve(agentAnswer());
  await tick();
  assert.equal(h.events.at(-1).kind, "failed", "a repeated answer naming it cannot publish");
});

const scope = "a".repeat(64);
const verdict = {
  reviewKind: "plan",
  scopeFingerprint: scope,
  verdict: "approve",
  summary: "Bounded",
  evidence: ["Read the plan"],
  findings: [],
};
const reviewRequest = (overrides = {}) => ({
  cwd: "/",
  registry: {},
  model: { provider: "anthropic", id: "claude-opus-5-5" },
  effort: "high",
  kind: "plan",
  scopeFingerprint: scope,
  systemPrompt: "SYSTEM",
  prompt: "REVIEW",
  timeoutMs: 5_000,
  maxCost: 1,
  ...overrides,
});
function builderHarness({ tools = [agentTool()], answer = agentAnswer(), published = true, liveTools = tools } = {}) {
  const sent = [];
  const quarantined = [];
  // Discovery only publishes grounded plans; an ungrounded answer leaves no publication.
  const plan = planFromAnswer(answer, tools);
  const runner = createBuilderReviewRunner({
    observe: () => (published && plan !== undefined ? { fingerprint: "f", generation: 1, plan } : undefined),
    tools: () => liveTools,
    blocked: () => false,
    quarantine: (_call, reason) => quarantined.push(reason),
    dispatch: (content) => sent.push(content),
  });
  return { runner, sent, quarantined };
}
const argsFrom = (content) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
const nonceOf = (text) => /nonce="([a-f0-9]{32})"/.exec(text)[1];
const resultEvent = (text, isError = false, toolCallId = "call-1", input = {}) => ({
  toolCallId,
  toolName: "Agent",
  input,
  content: [{ type: "text", text }],
  isError,
});

test("builder path: exact validated call, observed nonce verdict, and an unchanged tool_result", async () => {
  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  assert.equal(args.model, "anthropic/claude-opus-5-5");
  assert.equal(args.thinking, "high");
  assert.equal(args.isolated, true);
  assert.match(h.sent[0], /Do not request status, transcript, or verbose views/);
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: args });
  const wrapper = `Agent finished (tokens: 900)\nDone.\n<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify(verdict)}</router-result>`;
  const event = resultEvent(wrapper, false, "call-1", args);
  const before = structuredClone(event);
  assert.equal(h.runner.onToolResult(event), undefined, "observational: no replacement result");
  assert.deepEqual(event, before, "third-party wrapper text is left exactly as returned");
  h.runner.onSettled();
  const result = await handle.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.verdict, verdict);
});

test("builder path is unavailable without a publication or supported isolation, and dispatches nothing", async () => {
  for (const h of [
    builderHarness({ published: false }),
    builderHarness({ answer: { match: false } }),
    builderHarness({ answer: agentAnswer({ isolationEvidence: "trust me, no router" }) }),
    // The retained observation is stale: the live tool no longer documents isolation, so SDK is used.
    builderHarness({
      liveTools: [
        agentTool({
          parameters: Type.Object({
            prompt: Type.String(),
            description: Type.String(),
            subagent_type: Type.String(),
            model: Type.Optional(Type.String()),
            thinking: Type.Optional(Type.String()),
            run_in_background: Type.Optional(Type.Boolean()),
            isolated: Type.Optional(Type.Boolean()),
            inherit_context: Type.Optional(Type.Boolean()),
          }),
        }),
      ],
    }),
    builderHarness({ liveTools: [agentTool({ active: false })] }),
  ]) {
    assert.equal((await h.runner.start(reviewRequest()).result).status, "unavailable");
    assert.deepEqual(h.sent, []);
  }
  // A task too large to copy exactly would risk an uncertain, unrecoverable attempt: the SDK runs instead.
  const large = builderHarness();
  assert.equal((await large.runner.start(reviewRequest({ prompt: "x".repeat(12_001) })).result).status, "unavailable");
  assert.deepEqual(large.sent, []);
});

test("echoed instructions and deviating calls never count as a verdict", async () => {
  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: { ...args, isolated: false } });
  h.runner.onToolResult(
    resultEvent(
      `<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify(verdict)}</router-result>`,
      false,
      "call-1",
      { ...args, isolated: false },
    ),
  );
  h.runner.onSettled();
  assert.equal((await handle.result).status, "uncertain", "a deviated child may still run: no replacement");

  const echo = builderHarness();
  const echoed = echo.runner.start(reviewRequest());
  const echoArgs = argsFrom(echo.sent[0]);
  echo.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: echoArgs });
  echo.runner.onToolResult(resultEvent(`Task was: ${echoArgs.prompt}`, false, "call-1", echoArgs));
  echo.runner.onSettled();
  assert.equal((await echoed.result).status, "uncertain", "an echoed contract is not a verdict");
});

test("only an exact invocation's deterministic argument rejection quarantines the candidate", async () => {
  const cases = [
    ["Unknown parameter: isolated", true, ["argument_rejected"]],
    ["Model not found: anthropic/claude-opus-5-5", true, []],
    ["Unknown model: anthropic/claude-opus-5-5", true, []],
    ["Unsupported model: anthropic/claude-opus-5-5", true, []],
    ["Provider rate limit; isolated request unavailable", true, []],
    ["Invalid parameter model: must be one of the configured models", true, []],
    ["Unsupported parameter: temperature for model anthropic/claude-opus-5-5", true, []],
    ["Unknown parameter: isolated", false, []],
  ];
  for (const [message, exact, expected] of cases) {
    const h = builderHarness();
    const handle = h.runner.start(reviewRequest());
    const args = argsFrom(h.sent[0]);
    const input = exact ? args : { ...args, extra: 1 };
    h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input });
    h.runner.onToolResult(resultEvent(message, true, "call-1", input));
    h.runner.onSettled();
    assert.equal(
      (await handle.result).status,
      exact ? "failed" : "uncertain",
      "only a verified failure permits fallback",
    );
    assert.deepEqual(h.quarantined, expected, message);
  }
});

test("a failed spawn alongside a second spawn is uncertain, not a safe fallback", async () => {
  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: args });
  h.runner.onToolCall({ toolCallId: "call-2", toolName: "Agent", input: args });
  h.runner.onToolResult(resultEvent("Unknown parameter: isolated", true, "call-1", args));
  h.runner.onSettled();
  assert.equal((await handle.result).status, "uncertain");
  assert.deepEqual(h.quarantined, [], "a duplicate invocation is not an exact single call");
});

/** One manager tool with create/wait actions, documenting extension isolation. */
const managerTool = () =>
  agentTool({
    name: "subagent",
    parameters: Type.Object({
      action: Type.String({ enum: ["create", "wait", "status"] }),
      task: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      isolated: Type.Optional(Type.Boolean({ description: "If true, the child loads no extensions." })),
    }),
  });
const managerAnswer = {
  match: true,
  spawnTool: "subagent",
  spawnArguments: [
    { path: "action", literal: '"create"' },
    { path: "task", bind: "task" },
    { path: "model", bind: "model" },
    { path: "effort", bind: "effort" },
    { path: "isolated", literal: "true" },
  ],
  resultTool: "subagent",
  resultArguments: [
    { path: "action", literal: '"wait"' },
    { path: "id", bind: "child_id" },
  ],
  isolationArgument: "isolated",
  isolationEvidence: "If true, the child loads no extensions.",
};

const toolUsage = (cost = 0.25) => ({
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  totalTokens: 160,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

test("builder usage includes each correlated tool result once, not nested children or outer aggregates", async () => {
  const h = builderHarness({ tools: [managerTool()], answer: managerAnswer });
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "outer/1", parentToolCallId: "outer", toolName: "subagent", input: args });
  const spawn = {
    ...resultEvent("Started child agent-42", false, "outer/1", args),
    toolName: "subagent",
    parentToolCallId: "outer",
    usage: toolUsage(),
  };
  h.runner.onToolResult({ ...spawn, toolCallId: "outer/1/1", parentToolCallId: "outer/1", usage: toolUsage(9) });
  h.runner.onToolResult(spawn);
  h.runner.onToolResult(spawn); // Repeated notifications must not bill the same call twice.
  h.runner.onToolResult({
    ...spawn,
    toolCallId: "outer",
    toolName: "codemode",
    parentToolCallId: undefined,
    usage: toolUsage(9.25),
  });
  const input = { action: "wait", id: "agent-42" };
  h.runner.onToolCall({ toolCallId: "wait", toolName: "subagent", input });
  const block = `<router-result nonce="${nonceOf(args.task)}">${JSON.stringify(verdict)}</router-result>`;
  const event = { ...resultEvent(block, false, "wait", input), toolName: "subagent", usage: toolUsage(0.5) };
  const before = structuredClone(event);
  h.runner.onToolResult(event);
  h.runner.onToolResult(event);
  assert.deepEqual(event, before, "usage and payloads are observational only");
  h.runner.onSettled();
  const result = await handle.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { cost: 0.75, inputTokens: 280, outputTokens: 40 });
});

for (const status of ["completed", "failed", "uncertain", "cancelled", "timeout"]) {
  test(`builder retains reported tool usage for ${status}`, async () => {
    const h = builderHarness();
    const handle = h.runner.start(reviewRequest({ timeoutMs: status === "timeout" ? 10 : 5_000 }));
    const args = argsFrom(h.sent[0]);
    h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: args });
    const text =
      status === "completed"
        ? `<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify(verdict)}</router-result>`
        : "Provider unavailable";
    h.runner.onToolResult({ ...resultEvent(text, status === "failed", "call-1", args), usage: toolUsage() });
    if (status === "cancelled") handle.cancel();
    else if (status !== "timeout") h.runner.onSettled();
    const result = await handle.result;
    assert.equal(result.status, status);
    assert.deepEqual(result.usage, { cost: 0.25, inputTokens: 140, outputTokens: 20 });
    h.runner.onSettled();
  });
}

test("a companion wait counts only when it matches its template and the spawned child id", async () => {
  const run = async (resultInput) => {
    const h = builderHarness({ tools: [managerTool()], answer: managerAnswer });
    const handle = h.runner.start(reviewRequest());
    const args = argsFrom(h.sent[0]);
    const block = `<router-result nonce="${nonceOf(args.task)}">${JSON.stringify(verdict)}</router-result>`;
    h.runner.onToolCall({ toolCallId: "spawn", toolName: "subagent", input: args });
    h.runner.onToolResult({ ...resultEvent("Started child agent-42", false, "spawn", args), toolName: "subagent" });
    h.runner.onToolCall({ toolCallId: "wait", toolName: "subagent", input: resultInput });
    h.runner.onToolResult({ ...resultEvent(block, false, "wait", resultInput), toolName: "subagent" });
    h.runner.onSettled();
    return (await handle.result).status;
  };
  assert.equal(await run({ action: "wait", id: "agent-42" }), "completed");
  assert.equal(await run({ action: "status", id: "agent-42" }), "uncertain", "a status/transcript view");
  assert.equal(await run({ action: "wait", id: "agent-99" }), "uncertain", "an id the spawn never returned");
});

test("quarantine contracts keep a parameter named description and its constraints", () => {
  const quarantine = createQuarantine();
  const tools = [agentTool()];
  quarantine.add(bindPlan(planFromAnswer(agentAnswer(), tools), tools, values), "argument_rejected");
  const retyped = agentTool({
    parameters: Type.Object({
      ...agentTool().parameters.properties,
      description: Type.Number(),
    }),
  });
  assert.equal(quarantine.blocks(retyped, [retyped]), false, "retyping the description parameter is meaningful");
});

test("settling without a spawn is a safe non-launch; a spawn without a verdict is uncertain", async () => {
  const idle = builderHarness();
  const skipped = idle.runner.start(reviewRequest());
  idle.runner.onSettled();
  assert.equal((await skipped.result).status, "unavailable");

  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: args });
  h.runner.onToolResult(resultEvent("agent-7 started in the background", false, "call-1", args));
  h.runner.onSettled();
  assert.equal((await handle.result).status, "uncertain");
});

test("decisions wait for settle: mutated execution, a later duplicate, or a user abort never complete", async () => {
  const run = async (steps, aborted = false) => {
    const h = builderHarness();
    const handle = h.runner.start(reviewRequest());
    const args = argsFrom(h.sent[0]);
    const block = `<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify(verdict)}</router-result>`;
    steps(h.runner, args, block);
    h.runner.onSettled(aborted);
    return (await handle.result).status;
  };
  const exactCall = (runner, args, block, input = args) => {
    runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: args });
    runner.onToolResult(resultEvent(block, false, "call-1", input));
  };
  assert.equal(await run(exactCall), "completed");
  assert.equal(
    await run((runner, args, block) => exactCall(runner, args, block, { ...args, isolated: false })),
    "uncertain",
    "a later handler mutated the executed input",
  );
  assert.equal(
    await run((runner, args, block) => {
      exactCall(runner, args, block);
      runner.onToolCall({ toolCallId: "call-2", toolName: "Agent", input: args });
    }),
    "uncertain",
    "a duplicate after the verdict invalidates it",
  );
  assert.equal(await run(exactCall, true), "cancelled", "Escape cancels instead of falling forward");
  assert.equal(
    await run((runner, args) =>
      exactCall(runner, args, `<router-result nonce="${nonceOf(args.prompt)}">{}</router-result>`),
    ),
    "uncertain",
    "an invalid verdict from a launched child cannot authorize fallback",
  );
  assert.equal(
    await run((runner, args) =>
      exactCall(
        runner,
        args,
        `<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify({ ...verdict, scopeFingerprint: "b".repeat(64) })}</router-result>`,
      ),
    ),
    "uncertain",
    "a verdict for another scope is not ours",
  );
});

test("literal grounding keeps documented case and decimals; placeholders are not value-validated at publication", () => {
  const levelTool = (description, schema = Type.String({ description })) =>
    agentTool({
      parameters: Type.Object({
        prompt: Type.String({ minLength: 40 }),
        model: Type.String({ enum: ["anthropic/claude-opus-5-5"] }),
        effort: Type.String(),
        level: schema,
      }),
    });
  const answer = (literal, evidence) =>
    agentAnswer({
      spawnArguments: [
        { path: "prompt", bind: "task" },
        { path: "model", bind: "model" },
        { path: "effort", bind: "effort" },
        { path: "level", literal },
      ],
      isolationArgument: "level",
      isolationEvidence: evidence,
    });
  const upper = [levelTool("If NONE, the child loads no extensions.")];
  assert.ok(
    planFromAnswer(answer('"NONE"', "If NONE, the child loads no extensions."), upper),
    "placeholders ignore minLength/enum",
  );
  assert.equal(planFromAnswer(answer('"none"', "If none, the child loads no extensions."), upper), undefined);
  const decimal = [levelTool("", Type.Number({ description: "If -1.5, the child loads no extensions." }))];
  assert.ok(planFromAnswer(answer("-1.5", "If -1.5, the child loads no extensions."), decimal));
  assert.equal(planFromAnswer(answer("-1", "If -1.5, the child loads no extensions."), decimal), undefined);
  const plan = planFromAnswer(answer('"NONE"', "If NONE, the child loads no extensions."), upper);
  assert.equal(bindPlan(plan, upper, { ...values, task: "x".repeat(50) }).arguments.level, "NONE");
  assert.equal(bindPlan(plan, upper, { ...values, task: "short" }), undefined, "real values are validated at dispatch");
});

test("structurally invalid answers stay DIRTY; prototype paths and imprecise literals never ground", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.calls[0].resolve(
    agentAnswer({ spawnArguments: [...agentAnswer().spawnArguments, { path: "sandbox", literal: "1" }] }),
  );
  await tick();
  assert.equal(h.discovery.observe(), undefined);
  assert.equal(h.calls.length, 2, "the next access retries an unbindable answer");
  h.calls[1].resolve({ match: false });
  await tick();

  const tools = [agentTool()];
  const polluted = agentAnswer({
    spawnArguments: [...agentAnswer().spawnArguments, { path: "__proto__.routerPolluted", literal: "true" }],
  });
  assert.equal(planFromAnswer(polluted, tools), undefined);
  assert.equal({}.routerPolluted, undefined);

  const signed = agentTool({
    parameters: Type.Object({
      prompt: Type.String(),
      model: Type.String(),
      effort: Type.String(),
      level: Type.Number({ description: "If -1, the child loads no extensions." }),
    }),
  });
  const signedAnswer = (literal) =>
    agentAnswer({
      spawnArguments: [
        { path: "prompt", bind: "task" },
        { path: "model", bind: "model" },
        { path: "effort", bind: "effort" },
        { path: "level", literal },
      ],
      isolationArgument: "level",
      isolationEvidence: "If -1, the child loads no extensions.",
    });
  assert.ok(planFromAnswer(signedAnswer("-1"), [signed]));
  assert.equal(planFromAnswer(signedAnswer("1"), [signed]), undefined, "the sign is meaningful");
  assert.equal(
    planFromAnswer(agentAnswer({ isolationEvidence: "If TRUE, agent gets no extension/MCP tools" }), tools),
    undefined,
  );
});

test("a missing companion retains quarantine only while the spawn contract is unchanged", () => {
  const quarantine = createQuarantine();
  const tools = [managerTool()];
  const call = bindPlan(planFromAnswer(managerAnswer, tools), tools, values);
  quarantine.add(
    { ...call, result: { ...call.result, tool: { ...managerTool(), name: "wait_tool" } } },
    "argument_rejected",
  );
  assert.equal(quarantine.blocks(managerTool(), tools), true, "companion missing, spawn unchanged");
  const updated = agentTool({ name: "subagent", parameters: Type.Object({ task: Type.String() }) });
  assert.equal(quarantine.blocks(updated, [updated]), false, "an updated spawn is reconsidered");
});

test("publication validates fixed literals and nested required fields, leaving bad plans retryable", async () => {
  const tools = [agentTool()];
  const wrongLiteral = agentAnswer({
    // Pi's own validator would coerce 123 to "123"; a non-boolean string for a boolean cannot be coerced.
    spawnArguments: agentAnswer().spawnArguments.map((entry) =>
      entry.path === "run_in_background" ? { ...entry, literal: '"sometimes"' } : entry,
    ),
  });
  assert.equal(planFromAnswer(wrongLiteral, tools), undefined);
  const nested = agentTool({
    parameters: Type.Object({
      prompt: Type.String(),
      model: Type.String(),
      effort: Type.String(),
      options: Type.Object({
        isolated: Type.Boolean({ description: "If true, the child loads no extensions." }),
        mode: Type.String(),
      }),
    }),
  });
  const nestedAnswer = agentAnswer({
    spawnArguments: [
      { path: "prompt", bind: "task" },
      { path: "model", bind: "model" },
      { path: "effort", bind: "effort" },
      { path: "options.isolated", literal: "true" },
    ],
    isolationArgument: "options.isolated",
    isolationEvidence: "If true, the child loads no extensions.",
  });
  assert.equal(planFromAnswer(nestedAnswer, [nested]), undefined, "options.mode is required");
  const complete = {
    ...nestedAnswer,
    spawnArguments: [...nestedAnswer.spawnArguments, { path: "options.mode", literal: '"fresh"' }],
  };
  assert.ok(planFromAnswer(complete, [nested]));
  const h = harness(tools);
  h.discovery.observe();
  h.calls[0].resolve(wrongLiteral);
  await tick();
  h.discovery.observe();
  assert.equal(h.calls.length, 2, "an invalid literal leaves discovery DIRTY");
  h.calls[1].resolve(agentAnswer());
  await tick();

  const wrongType = agentAnswer({
    spawnArguments: agentAnswer().spawnArguments.map((entry) =>
      entry.path === "subagent_type" ? { ...entry, literal: "123" } : entry,
    ),
  });
  assert.equal(planFromAnswer(wrongType, tools), undefined, "literal validation cannot silently coerce types");
  const nestedDiscovery = harness([nested]);
  nestedDiscovery.discovery.observe();
  nestedDiscovery.calls[0].resolve(nestedAnswer);
  await tick();
  assert.equal(nestedDiscovery.discovery.observe(), undefined);
  assert.equal(nestedDiscovery.calls.length, 2, "missing nested fields leave discovery DIRTY too");
  nestedDiscovery.calls[1].resolve(complete);
  await tick();
  assert.ok(nestedDiscovery.discovery.observe().plan);

  const companion = managerTool();
  const invalidWait = {
    ...managerAnswer,
    resultArguments: [
      { path: "action", literal: '"create-again"' },
      { path: "id", bind: "child_id" },
    ],
  };
  assert.equal(planFromAnswer(invalidWait, [companion]), undefined, "companion literals are checked too");
});

test("off-plan calls and unmatched companions are deviations that never authorize fallback", async () => {
  const offPlan = builderHarness();
  const first = offPlan.runner.start(reviewRequest());
  offPlan.runner.onToolCall({ toolCallId: "other", toolName: "another_agent_tool", input: { task: "x" } });
  offPlan.runner.onSettled();
  assert.equal((await first.result).status, "uncertain", "another agent tool may have launched a child");

  const h = builderHarness({ tools: [managerTool()], answer: managerAnswer });
  const second = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "spawn", toolName: "subagent", input: args });
  h.runner.onToolResult({ ...resultEvent("Unknown parameter: isolated", true, "spawn", args), toolName: "subagent" });
  h.runner.onToolCall({ toolCallId: "other", toolName: "subagent", input: { action: "create", task: "x" } });
  h.runner.onSettled();
  assert.equal((await second.result).status, "uncertain", "a later create is a second, unverified launch");
  assert.deepEqual(h.quarantined, []);
});

test("unverified distinct companions prevent fallback before or after a failed spawn, while abort wins", async () => {
  const spawn = agentTool();
  const companion = { ...managerTool(), name: "companion" };
  const answer = agentAnswer({ resultTool: "companion", resultArguments: managerAnswer.resultArguments });
  for (const failedSpawn of [false, true]) {
    for (const aborted of [false, true]) {
      const separate = builderHarness({ tools: [spawn, companion], answer });
      const handle = separate.runner.start(reviewRequest());
      const planned = argsFrom(separate.sent[0]);
      if (failedSpawn) {
        separate.runner.onToolCall({ toolCallId: "spawn", toolName: "Agent", input: planned });
        separate.runner.onToolResult(resultEvent("Unknown parameter: isolated", true, "spawn", planned));
      }
      // A different, multi-action companion can launch a child even with no successful planned spawn.
      separate.runner.onToolCall({ toolCallId: "foreign", toolName: "companion", input: { action: "create" } });
      separate.runner.onSettled(aborted);
      assert.equal((await handle.result).status, aborted ? "cancelled" : "uncertain");
      assert.deepEqual(separate.quarantined, [], "unverified companion calls cannot establish safe non-launch");
    }
  }
});

test("unrelated optional spawn and companion fields do not clear execution quarantine", () => {
  const quarantine = createQuarantine();
  const spawn = agentTool();
  const companion = { ...managerTool(), name: "companion" };
  const tools = [spawn, companion];
  const answer = agentAnswer({ resultTool: "companion", resultArguments: managerAnswer.resultArguments });
  quarantine.add(bindPlan(planFromAnswer(answer, tools), tools, values), "argument_rejected");
  const updated = (tool) => ({
    ...tool,
    parameters: Type.Object({ ...tool.parameters.properties, cosmetic: Type.Optional(Type.String()) }),
  });
  const nextSpawn = updated(spawn);
  const nextCompanion = updated(companion);
  assert.equal(quarantine.blocks(nextSpawn, [nextSpawn, companion]), true, "unused optional spawn addition");
  assert.equal(quarantine.blocks(spawn, [spawn, nextCompanion]), true, "unused optional companion addition");
  const changed = {
    ...nextSpawn,
    parameters: Type.Object({ ...nextSpawn.parameters.properties, isolated: Type.String() }),
  };
  assert.equal(quarantine.blocks(changed, [changed, nextCompanion]), false, "used isolation constraint changed");
});

test("a timed-out attempt's run stays guarded until it settles, and no new attempt overlaps it", async () => {
  const h = builderHarness();
  assert.equal((await h.runner.start(reviewRequest({ timeoutMs: 5 })).result).status, "timeout");
  assert.equal(h.runner.delegating(), true, "the dispatched run is still executing");
  assert.equal((await h.runner.start(reviewRequest()).result).status, "unavailable");
  assert.equal(h.sent.length, 1, "no second dispatch while the first run is alive");
  h.runner.onSettled();
  assert.equal(h.runner.delegating(), false);
  const next = h.runner.start(reviewRequest());
  assert.equal(h.sent.length, 2);
  next.cancel();
  assert.equal((await next.result).status, "cancelled");
});

test("builder deadline is a timeout without replacement, and cancellation is stale", async () => {
  const h = builderHarness();
  assert.equal((await h.runner.start(reviewRequest({ timeoutMs: 5 })).result).status, "timeout");
  h.runner.onSettled();
  const handle = h.runner.start(reviewRequest());
  handle.cancel();
  assert.equal((await handle.result).status, "cancelled");
});
