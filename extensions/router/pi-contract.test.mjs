// Pi host contract canary. Each test drives a real Pi session, extension runtime, and model runtime with
// the offline fixture provider, and asserts the exact Pi behavior the router relies on, including the
// accepted private `ModelRegistry.runtime` field. Ordinary CI runs it against the pinned development
// Pi; the scheduled canary workflow reruns it against isolated Pi 1.2.0 and latest-release fixtures
// (see scripts/pi-contract-canary.mjs), where PI_CONTRACT_EXPECTED_VERSION pins the version under test.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { sdkFixture, streamMessage } from "./fixtures/pi-sdk.mjs";
import { inProcessReviewRunner } from "./review-runner.ts";

const DRIFT = "Pi contract drift";

/**
 * The canary's strict form of review-runner.ts's production guard. Production skips the review on a
 * missing or incompatible field; the canary must instead fail with an actionable message.
 */
function privateRuntime(registry) {
  const runtime = Reflect.get(registry, "runtime");
  if (!(runtime instanceof ModelRuntime))
    throw new Error(
      `${DRIFT}: ExtensionContext.modelRegistry.runtime is ${runtime === undefined ? "missing" : "not a ModelRuntime"}; the in-process reviewer would skip every review as runtime_unavailable.`,
    );
  for (const method of ["getModel", "streamSimple"])
    if (typeof runtime[method] !== "function")
      throw new Error(`${DRIFT}: ModelRuntime.${method} is no longer callable.`);
  return runtime;
}

/** A real parent session whose only extensions are the supplied inline factories. */
async function parentSession(t, f, extensionFactories, options = {}) {
  const loader = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: f.cwd,
    agentDir: f.cwd,
    resourceLoader: loader,
    modelRuntime: f.runtime,
    model: f.model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(f.cwd),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      ...options.settings,
    }),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  return session;
}

const scope = "c".repeat(64);
const verdict = {
  reviewKind: "plan",
  scopeFingerprint: scope,
  verdict: "approve",
  summary: "Bounded",
  evidence: ["Inspected plan"],
  findings: [],
};

function packageDirectory(specifier) {
  let directory = fileURLToPath(import.meta.resolve(specifier));
  // Walk up from the resolved entry file to the package root (`package.json` is not an exported subpath).
  for (let next = resolve(directory, ".."); next !== directory; next = resolve(next, ".."))
    if (next.endsWith(join("node_modules", ...specifier.split("/")))) return realpathSync(next);
    else directory = next;
  throw new Error(`Cannot locate the package directory of ${specifier}`);
}

test("the Pi under test resolves from the selected installation and is in the supported range", () => {
  const packages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];
  const directories = Object.fromEntries(packages.map((name) => [name, packageDirectory(name)]));
  console.log(`Pi contract canary: pi-coding-agent ${VERSION} from ${directories[packages[0]]}`);
  const expected = process.env.PI_CONTRACT_EXPECTED_VERSION;
  const fixture = process.env.PI_CONTRACT_FIXTURE;
  if (expected) {
    assert.equal(VERSION, expected, `${DRIFT}: the canary loaded Pi ${VERSION}, not the selected ${expected}`);
    assert.ok(fixture, "PI_CONTRACT_FIXTURE must accompany PI_CONTRACT_EXPECTED_VERSION");
    const prefix = realpathSync(fixture);
    for (const [name, directory] of Object.entries(directories))
      assert.ok(directory.startsWith(prefix), `${name} resolved from ${directory}, outside the fixture ${prefix}`);
  }
  const [major, minor] = VERSION.split(".").map(Number);
  assert.ok(major === 1 && minor >= 2, `Pi ${VERSION} is outside the supported >=1.2.0 <2.0.0 range`);
});

test("an actual extension context exposes the private model runtime, and a reviewer reuses its auth and model", async (t) => {
  const f = await sdkFixture(t);
  // A runtime-only key: a separately created default runtime could not have it.
  await f.runtime.setRuntimeApiKey("fixture", "runtime-only-key");
  let registry;
  const session = await parentSession(t, f, [
    (pi) => {
      pi.on("before_agent_start", (_event, ctx) => {
        registry = ctx.modelRegistry;
      });
    },
  ]);
  f.respond = (model) => streamMessage(model, [{ type: "text", text: "parent" }]);
  await session.prompt("Parent turn");
  assert.ok(registry instanceof ModelRegistry, `${DRIFT}: ExtensionContext.modelRegistry is not a ModelRegistry`);
  assert.equal(privateRuntime(registry), f.runtime, `${DRIFT}: the context runtime is not the session's runtime`);

  const disposed = t.mock.method(AgentSession.prototype, "dispose");
  f.requests.length = 0;
  let calls = 0;
  f.respond = (model) =>
    calls++ === 0
      ? streamMessage(
          model,
          [{ type: "toolCall", id: "verdict", name: "submit_safety_review", arguments: verdict }],
          "toolUse",
        )
      : streamMessage(model, []);
  const result = await inProcessReviewRunner.start({
    cwd: f.cwd,
    registry,
    model: f.reasoningModel,
    effort: "high",
    kind: "plan",
    scopeFingerprint: scope,
    systemPrompt: "REVIEW_ONLY_SYSTEM",
    prompt: "Review this bounded task",
    timeoutMs: 5000,
    maxCost: 1,
  }).result;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verdict, verdict);
  assert.equal(f.requests.length, 2);
  for (const { model, context, options } of f.requests) {
    assert.equal(`${model.provider}/${model.id}`, "fixture/reasoning", "the selected model is used");
    assert.equal(options.reasoning, "high", "the selected effort reaches the provider");
    assert.equal(options.apiKey, "runtime-only-key", "the parent runtime's credentials are reused");
    assert.doesNotMatch(JSON.stringify(context), /SHOULD_NOT_LOAD_RECURSIVELY/);
  }
  assert.equal(globalThis.__routerReviewerFactoryLoaded, undefined, "no ambient project router was loaded");
  // Abort/dispose: the finished reviewer session is disposed; the parent session is untouched.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(disposed.mock.calls.length > 0, "the reviewer session is disposed after settling");
  assert.ok(
    disposed.mock.calls.every((call) => call.this !== session),
    "review cleanup never disposes the parent",
  );
  assert.equal(session.model, f.model);
  assert.equal(session.thinkingLevel, "off");
});

test("a missing private runtime fails the canary clearly and skips the production review without a crash", async (t) => {
  const f = await sdkFixture(t);
  const drifted = new ModelRegistry(f.runtime);
  Reflect.defineProperty(drifted, "runtime", { value: undefined });
  assert.throws(
    () => privateRuntime(drifted),
    /Pi contract drift: ExtensionContext\.modelRegistry\.runtime is missing/,
  );
  Reflect.defineProperty(drifted, "runtime", { value: { getModel: () => f.model } });
  assert.throws(() => privateRuntime(drifted), /runtime is not a ModelRuntime/);

  f.respond = () => assert.fail("no provider request may be made without the parent runtime");
  const result = await inProcessReviewRunner.start({
    cwd: f.cwd,
    registry: drifted,
    model: f.model,
    effort: "off",
    kind: "plan",
    scopeFingerprint: scope,
    systemPrompt: "REVIEW_ONLY_SYSTEM",
    prompt: "Review",
    timeoutMs: 1000,
    maxCost: 1,
  }).result;
  assert.equal(result.status, "runtime_unavailable");
  assert.equal(result.verdict, undefined);
  assert.equal(f.requests.length, 0);
});

test("getAllTools reports the tool metadata and exposure the router fingerprints, and active tools match", async (t) => {
  const f = await sdkFixture(t);
  let pi;
  const parameters = Type.Object({ query: Type.String({ description: "What to look up" }) });
  const session = await parentSession(t, f, [
    (api) => {
      pi = api;
      api.registerTool({
        name: "canary_direct",
        label: "Canary direct",
        description: "A directly declared fixture tool",
        promptGuidelines: ["Use canary_direct for fixture lookups."],
        parameters,
        annotations: { readOnlyHint: true },
        execute: async () => ({ content: [{ type: "text", text: "direct" }], details: undefined }),
      });
      api.registerTool({
        name: "canary_codemode",
        label: "Canary codemode",
        description: "A fixture tool reachable only from scripts",
        parameters,
        exposure: "codemode",
        namespace: { name: "canary", description: "Fixture namespace" },
        execute: async () => ({ content: [{ type: "text", text: "codemode" }], details: undefined }),
      });
    },
  ]);
  const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  for (const name of ["read", "canary_direct", "canary_codemode"]) {
    const tool = tools.get(name);
    assert.ok(tool, `${DRIFT}: getAllTools() omits ${name}`);
    assert.equal(typeof tool.description, "string", `${name}.description`);
    assert.equal(typeof tool.parameters, "object", `${name}.parameters`);
    assert.equal(typeof tool.exposure, "string", `${name}.exposure`);
    for (const field of ["path", "source", "scope", "origin"])
      assert.equal(typeof tool.sourceInfo?.[field], "string", `${name}.sourceInfo.${field}`);
  }
  const direct = tools.get("canary_direct");
  assert.equal(direct.description, "A directly declared fixture tool");
  assert.deepEqual(direct.parameters, parameters);
  assert.deepEqual(direct.promptGuidelines, ["Use canary_direct for fixture lookups."]);
  assert.equal(direct.exposure, "direct");
  assert.deepEqual(direct.annotations, { readOnlyHint: true });
  assert.equal(tools.get("read").exposure, "direct");
  const scripted = tools.get("canary_codemode");
  assert.equal(scripted.exposure, "codemode");
  assert.equal(scripted.namespace?.name, "canary");

  const active = pi.getActiveTools();
  assert.deepEqual(active, session.getActiveToolNames(), "extension and session views of active tools agree");
  assert.ok(active.includes("read") && active.includes("canary_direct"), JSON.stringify(active));
  assert.ok(!active.includes("canary_codemode"), "codemode-only tools are registered but not activated");
  pi.setActiveTools(["read", "canary_direct", "not_registered"]);
  assert.deepEqual(pi.getActiveTools().sort(), ["canary_direct", "read"], "unknown names are ignored");
});

test("sendMessage with triggerTurn starts exactly one run whose before_agent_start is a custom run", async (t) => {
  const f = await sdkFixture(t);
  let pi;
  const starts = [];
  let settled;
  const session = await parentSession(t, f, [
    (api) => {
      pi = api;
      api.on("before_agent_start", (event) => {
        starts.push({ messageType: event.messageType, prompt: event.prompt, message: event.message });
      });
      api.on("agent_settled", () => settled?.());
    },
  ]);
  f.respond = (model) => streamMessage(model, [{ type: "text", text: "ok" }]);
  await session.prompt("A user prompt");
  assert.deepEqual(
    starts.map((start) => [start.messageType, start.prompt]),
    [["user", "A user prompt"]],
  );

  starts.length = 0;
  f.requests.length = 0;
  const done = new Promise((resolve) => {
    settled = resolve;
  });
  pi.sendMessage({ customType: "canary-wake", content: "Advice arrived", display: false }, { triggerTurn: true });
  await done;
  assert.equal(starts.length, 1, `${DRIFT}: expected one before_agent_start, saw ${starts.length}`);
  assert.equal(starts[0].messageType, "custom", `${DRIFT}: triggerTurn runs must report messageType "custom"`);
  assert.equal(starts[0].prompt, undefined);
  assert.equal(starts[0].message?.customType, "canary-wake");
  assert.equal(f.requests.length, 1, "the custom run made one provider request and no duplicate dispatch");
  assert.match(JSON.stringify(f.requests[0].context.messages), /Advice arrived/);
});

test("tool_result observation leaves direct and nested third-party results unchanged", async (t) => {
  const f = await sdkFixture(t);
  const observed = [];
  let outcome;
  const nonce = "router-nonce-7f3a";
  const returned = {
    content: [{ type: "text", text: `wrapper stats\n<review nonce="${nonce}">{"verdict":"approve"}</review>` }],
    structuredContent: { verdict: "approve", nonce },
    details: { manager: "third-party", turns: 3 },
    isError: true,
  };
  const session = await parentSession(t, f, [
    (pi) => {
      pi.registerTool({
        name: "third_party_result",
        label: "Third party",
        description: "A third-party manager result",
        parameters: Type.Object({ id: Type.String() }),
        outputSchema: Type.Object({ verdict: Type.String(), nonce: Type.String() }),
        execute: async () => structuredClone(returned),
      });
      pi.registerTool({
        name: "third_party_wrapper",
        label: "Wrapper",
        description: "Calls the third-party tool as a nested call",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal, _onUpdate, ctx) => {
          outcome = structuredClone(await ctx.executeTool("third_party_result", { id: "nested" }, { signal }));
          return { content: outcome.result.content, details: { nested: outcome.result.details } };
        },
      });
    },
    (pi) => {
      // Router-shaped observer: inspect text, return nothing.
      pi.on("tool_result", (event) => {
        observed.push(structuredClone(event));
        return undefined;
      });
    },
  ]);
  let calls = 0;
  f.respond = (model) =>
    calls++ === 0
      ? streamMessage(
          model,
          [
            { type: "toolCall", id: "direct", name: "third_party_result", arguments: { id: "direct" } },
            { type: "toolCall", id: "wrap", name: "third_party_wrapper", arguments: {} },
          ],
          "toolUse",
        )
      : streamMessage(model, []);
  await session.prompt("Collect results");

  const direct = observed.find((event) => event.toolCallId === "direct");
  const nested = observed.find((event) => event.parentToolCallId === "wrap");
  assert.ok(direct && nested, JSON.stringify(observed));
  assert.equal(nested.toolCallId, "wrap/1");
  for (const event of [direct, nested]) {
    assert.equal(event.toolName, "third_party_result");
    assert.deepEqual(event.content, returned.content);
    assert.deepEqual(event.structuredContent, returned.structuredContent);
    assert.deepEqual(event.details, returned.details);
    assert.equal(event.isError, true);
    assert.match(event.content[0].text, new RegExp(`nonce="${nonce}"`));
  }
  assert.deepEqual(direct.input, { id: "direct" });
  assert.deepEqual(nested.input, { id: "nested" });

  const results = new Map(
    session.messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]),
  );
  const transcript = results.get("direct");
  assert.deepEqual(transcript.content, returned.content, "the transcript keeps the third-party content");
  assert.deepEqual(transcript.details, returned.details);
  assert.equal(transcript.isError, true);
  // The calling tool receives the nested result exactly as the third-party tool returned it.
  assert.equal(outcome.isError, true);
  assert.deepEqual(outcome.result.content, returned.content);
  assert.deepEqual(outcome.result.details, returned.details);
  assert.deepEqual(outcome.result.structuredContent, returned.structuredContent);
  assert.deepEqual(results.get("wrap").content, returned.content);
});

test("the extension event bus consumes synchronously, replies in a microtask, and reload drops old listeners", async (t) => {
  const f = await sdkFixture(t);
  const log = [];
  const generations = [];
  let generation = 0;
  const session = await parentSession(t, f, [
    (pi) => {
      const mine = ++generation;
      generations.push(pi);
      pi.events.on("canary:request", (data) => {
        log.push(`consume:${mine}:${data.id}`);
        queueMicrotask(() => pi.events.emit("canary:reply", data));
      });
      pi.events.on("canary:reply", (data) => log.push(`reply:${mine}:${data.id}`));
    },
  ]);
  const [first] = generations;
  first.events.emit("canary:request", { id: 1 });
  log.push("after-emit");
  await Promise.resolve();
  assert.deepEqual(log, ["consume:1:1", "after-emit", "reply:1:1"], `${DRIFT}: event bus ordering changed`);

  await session.reload();
  assert.equal(generations.length, 2, "reload re-runs the extension factory");
  assert.throws(() => first.events.emit("canary:request", { id: 0 }), /stale/, "a pre-reload pi handle is invalidated");
  log.length = 0;
  generations[1].events.emit("canary:request", { id: 2 });
  await Promise.resolve();
  assert.deepEqual(log, ["consume:2:2", "reply:2:2"], `${DRIFT}: listeners from before reload still receive events`);
});
