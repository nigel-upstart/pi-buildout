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
});

test("a tool change aborts the prior flight; an ignored abort cannot publish", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.setTools([agentTool(), other("late")]);
  h.discovery.observe();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 2);
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.equal(h.discovery.observe(), undefined, "the superseded flight ignored abort but cannot publish");
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
  assert.equal(h.calls.length, 2, "the next access retries once");
  h.setTools([agentTool(), other("x")]);
  h.discovery.observe();
  assert.equal(h.calls[1].signal.aborted, true, "a tool change cancels the retry too");
  h.calls[0].resolve(agentAnswer());
  await tick();
  assert.equal(h.discovery.observe(), undefined, "the timed-out flight cannot publish later");
});

test("failures do not publish; the next access retries", async () => {
  const h = harness([agentTool()]);
  h.discovery.observe();
  h.calls[0].resolve({ match: true, spawnTool: "Agent" });
  await tick();
  assert.equal(h.discovery.observe(), undefined);
  assert.equal(h.calls.length, 2);
  assert.equal(h.events[0].kind, "failed");
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
const resultEvent = (text, isError = false, toolCallId = "call-1") => ({
  toolCallId,
  toolName: "Agent",
  input: {},
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
  const event = resultEvent(wrapper);
  const before = structuredClone(event);
  assert.equal(h.runner.onToolResult(event), undefined, "observational: no replacement result");
  assert.deepEqual(event, before, "third-party wrapper text is left exactly as returned");
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
});

test("echoed instructions and deviating calls never count as a verdict", async () => {
  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  const args = argsFrom(h.sent[0]);
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: { ...args, isolated: false } });
  h.runner.onToolResult(
    resultEvent(`<router-result nonce="${nonceOf(args.prompt)}">${JSON.stringify(verdict)}</router-result>`),
  );
  h.runner.onSettled();
  assert.equal((await handle.result).status, "uncertain", "a deviated child may still run: no replacement");

  const echo = builderHarness();
  const echoed = echo.runner.start(reviewRequest());
  const echoArgs = argsFrom(echo.sent[0]);
  echo.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: echoArgs });
  echo.runner.onToolResult(resultEvent(`Task was: ${echoArgs.prompt}`));
  assert.equal((await echoed.result).status, "uncertain", "an echoed contract is not a verdict");
});

test("only an exact invocation's deterministic argument rejection quarantines the candidate", async () => {
  const cases = [
    ["Unknown parameter: isolated", true, ["argument_rejected"]],
    ["Model not found: anthropic/claude-opus-5-5", true, []],
    ["Provider rate limit; isolated request unavailable", true, []],
    ["Unknown parameter: isolated", false, []],
  ];
  for (const [message, exact, expected] of cases) {
    const h = builderHarness();
    const handle = h.runner.start(reviewRequest());
    const args = argsFrom(h.sent[0]);
    h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: exact ? args : { ...args, extra: 1 } });
    h.runner.onToolResult(resultEvent(message, true));
    assert.equal((await handle.result).status, "failed", "a failed spawn launched nothing: fallback is safe");
    assert.deepEqual(h.quarantined, expected, message);
  }
});

test("settling without a spawn is a safe non-launch; a spawn without a verdict is uncertain", async () => {
  const idle = builderHarness();
  const skipped = idle.runner.start(reviewRequest());
  idle.runner.onSettled();
  assert.equal((await skipped.result).status, "unavailable");

  const h = builderHarness();
  const handle = h.runner.start(reviewRequest());
  h.runner.onToolCall({ toolCallId: "call-1", toolName: "Agent", input: argsFrom(h.sent[0]) });
  h.runner.onToolResult(resultEvent("agent-7 started in the background"));
  assert.equal((await handle.result).status, "uncertain");
});

test("builder deadline is a timeout without replacement, and cancellation is stale", async () => {
  const h = builderHarness();
  assert.equal((await h.runner.start(reviewRequest({ timeoutMs: 5 })).result).status, "timeout");
  const handle = h.runner.start(reviewRequest());
  handle.cancel();
  assert.equal((await handle.result).status, "cancelled");
});
