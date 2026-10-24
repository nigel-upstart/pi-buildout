import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { buildKickoffPrompt } from "./rpc.ts";

// Mock only the extension's external boundaries. Exercise its real create dispatcher,
// compaction orchestration, utilityCompletion, classifier, and context bounding.
const indexUrl = new URL("./index.ts", import.meta.url).href;
const fixtureKey = "pi-subagents-create-test";
/** @type {{
 * dir: string; compactions: number; historyBuilds: number; disposals: number;
 * utilityPrompts: string[]; compactionPrompts: string[];
 * launches: import('./rpc.ts').ChildLaunchOptions[]; stops: number;
 * summary: string; failCompaction: boolean;
 * classify: (() => Promise<void>) | undefined; start: (() => Promise<void>) | undefined;
 * snapshot: Partial<import('./rpc.ts').ChildSnapshot>;
 * wait: ((timeoutMs: number, signal?: AbortSignal) => Promise<boolean>) | undefined;
 * }} */
const fixture = {
  dir: "",
  compactions: 0,
  historyBuilds: 0,
  disposals: 0,
  utilityPrompts: [],
  compactionPrompts: [],
  launches: [],
  stops: 0,
  summary: "parent-only-sentinel " + "s".repeat(50_000),
  failCompaction: false,
  classify: undefined,
  start: undefined,
  snapshot: {},
  wait: undefined,
};
Reflect.set(globalThis, fixtureKey, fixture);
const mocks = {
  "@earendil-works/pi-ai/compat": `
    export { StringEnum } from '@earendil-works/pi-ai/compat';
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export async function completeSimple(model, context) {
      f.utilityPrompts.push(JSON.stringify(context));
      await f.classify?.();
      return { content: [{ type: 'text', text: JSON.stringify({ model: 'test/model', effort: 'high' }) }] };
    }
  `,
  "@earendil-works/pi-coding-agent": `
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export function getAgentDir() { return f.dir; }
    export function buildSessionContext(entries) { f.historyBuilds++; return { messages: entries }; }
    export const SessionManager = { inMemory: () => ({ appendMessage() {}, appendCustomMessageEntry() {} }) };
    export const SettingsManager = { inMemory: () => ({}) };
    export class DefaultResourceLoader { async reload() {} }
    export async function createAgentSession() {
      return { session: {
        async compact(prompt) {
          f.compactions++; f.compactionPrompts.push(prompt);
          if (f.failCompaction) throw new Error('compaction unavailable');
          return { summary: f.summary };
        },
        abortCompaction() {}, dispose() { f.disposals++; }
      } };
    }
  `,
  "./rpc.ts": `
    const f = globalThis[${JSON.stringify(fixtureKey)}];
    export class ManagedSubagent {
      constructor(options) { this.options = options; f.launches.push(options); }
      async start() { await f.start?.(); }
      async stop() { f.stops++; }
      async refresh() {}
      async waitForIdle(timeoutMs, signal) { return f.wait ? f.wait(timeoutMs, signal) : true; }
      isAlive() { return true; }
      snapshot() {
        const o = this.options;
        return { id: o.id, name: o.name, task: o.task, state: 'running', model: o.model,
          effort: o.effort, contextMode: o.contextMode ?? 'task_compacted', classification: o.classification,
          startedAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0,
          pendingMessages: 0, compactions: 0, transcriptTail: '', ...f.snapshot }; 
      }
    }
  `,
};
const mockPrefix = new URL("./__mock__", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === indexUrl && Object.hasOwn(mocks, specifier)) {
      return { url: `${mockPrefix}${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(mockPrefix)) {
      const key = /** @type {keyof typeof mocks} */ (decodeURIComponent(url.slice(mockPrefix.length)));
      return { format: "module", source: mocks[key], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { default: subagentsExtension } = await import("./index.ts");
hooks.deregister();

/** @param {import('node:test').TestContext} t @param {boolean} [forbidHistory] */
async function harness(t, forbidHistory = false) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-create-"));
  fixture.dir = dir;
  fixture.compactions = fixture.historyBuilds = fixture.disposals = fixture.stops = 0;
  fixture.utilityPrompts = [];
  fixture.compactionPrompts = [];
  fixture.launches = [];
  fixture.failCompaction = false;
  fixture.classify = fixture.start = undefined;
  fixture.snapshot = {};
  fixture.wait = undefined;
  t.after(async () => rm(dir, { recursive: true, force: true }));
  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition | undefined} */
  let tool;
  /** @type {Record<string, (event: unknown, ctx: unknown) => unknown>} */
  const lifecycle = {};
  const emitter = new EventEmitter();
  const events = {
    emit: (/** @type {string} */ name, /** @type {unknown} */ value) => emitter.emit(name, value),
    on(/** @type {string} */ name, /** @type {(value: unknown) => void} */ callback) {
      emitter.on(name, callback);
      return () => emitter.off(name, callback);
    },
  };
  subagentsExtension(
    /** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ (
      /** @type {unknown} */ ({
        registerTool: (/** @type {import('@earendil-works/pi-coding-agent').ToolDefinition} */ registered) => {
          tool = registered;
        },
        on(/** @type {string} */ name, /** @type {(event: unknown, ctx: unknown) => unknown} */ handler) {
          lifecycle[name] = handler;
        },
        events,
        getThinkingLevel: () => "high",
      })
    ),
  );
  const model = { provider: "test", id: "model", reasoning: true, contextWindow: 8_000 };
  const sessionManager = {
    getEntries() {
      return [{ role: "assistant", content: "parent-only-sentinel" }];
    },
    getLeafId: () => "leaf",
    getSessionId: () => "parent",
  };
  if (forbidHistory) {
    for (const key of ["getEntries", "getLeafId", "getBranch"]) {
      Object.defineProperty(sessionManager, key, {
        get() {
          throw new Error("Parent transcript must not be read");
        },
      });
    }
  }
  const ctx = /** @type {import('@earendil-works/pi-coding-agent').ExtensionToolContext} */ (
    /** @type {unknown} */ ({
      cwd: fixture.dir,
      model,
      sessionManager,
      isProjectTrusted: () => false,
      modelRegistry: {
        runtime: {},
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
      },
    })
  );
  assert.ok(tool);
  const registered = tool;
  /** @param {Record<string, unknown>} args @param {AbortSignal} [signal] */
  const execute = (args, signal) => registered.execute("test-call", args, signal, undefined, ctx);
  return { execute, tool: registered, ctx, lifecycle, events };
}

/** @param {{emit: Function, on: Function}} events @param {string} method @param {Record<string, unknown>} fields */
function rpc(events, method, fields = {}) {
  const requestId = `req-${method}-${String(Math.random())}`;
  return new Promise((resolve) => {
    const off = events.on(`subagents:rpc:${method}:reply:${requestId}`, (/** @type {unknown} */ reply) => {
      off();
      resolve(/** @type {Record<string, unknown>} */ (reply));
    });
    events.emit(`subagents:rpc:${method}`, { requestId, ...fields });
  });
}

test("default and explicit task_compacted preserve bounded task compaction", async (t) => {
  for (const contextMode of [undefined, "task_compacted"]) {
    const { execute } = await harness(t);
    const result = await execute({ action: "create", task: "Do the task", ...(contextMode ? { contextMode } : {}) });
    assert.equal(fixture.compactions, 1);
    assert.equal(fixture.historyBuilds, 1);
    assert.equal(fixture.disposals, 1);
    assert.match(fixture.compactionPrompts[0] ?? "", /Do the task/);
    const launch = fixture.launches[0];
    assert.ok(launch);
    assert.equal(launch.contextMode, "task_compacted");
    assert.match(launch.contextSummary, /parent-only-sentinel/);
    assert.ok(launch.contextSummary.length < 9_600);
    assert.match(fixture.utilityPrompts[0] ?? "", /parent-only-sentinel/);
    assert.match(buildKickoffPrompt(launch.task, launch.contextSummary), /<context>/);
    assert.equal(Reflect.get(result.details, "contextMode"), "task_compacted");
  }
});

test("none never reads history or compacts; automatic selection sees only task and catalog", async (t) => {
  const { execute, tool } = await harness(t, true);
  fixture.failCompaction = true;
  assert.deepEqual(tool.parameters.properties.contextMode?.enum, ["task_compacted", "none"]);
  const result = await execute({ action: "create", task: "Do the task", contextMode: "none" });
  assert.equal(fixture.compactions, 0);
  assert.equal(fixture.historyBuilds, 0);
  assert.equal(fixture.utilityPrompts.length, 1);
  assert.match(fixture.utilityPrompts[0] ?? "", /Do the task/);
  assert.match(fixture.utilityPrompts[0] ?? "", /test\/model/);
  assert.doesNotMatch(fixture.utilityPrompts[0] ?? "", /parent-only-sentinel/);
  const launch = fixture.launches[0];
  assert.ok(launch);
  assert.equal(launch.classification, "classified");
  assert.equal(launch.effort, "high");
  assert.equal(launch.contextSummary, "");
  assert.equal(buildKickoffPrompt(launch.task, launch.contextSummary), "Task:\nDo the task");
  assert.equal(Reflect.get(result.details, "contextMode"), "none");
  assert.equal(Reflect.get(result.details, "compactionFallback"), false);
  assert.doesNotMatch(JSON.stringify(result), /failed open|fresh context|parent-only-sentinel/);
  for (const action of ["status", "list"]) {
    const status = await execute({ action, id: launch.id });
    assert.match(JSON.stringify(status), /contextMode=none/);
    assert.match(JSON.stringify(status.details), /"contextMode":"none"/);
  }
});

test("none with explicit model and effort bypasses classification", async (t) => {
  const { execute } = await harness(t, true);
  await execute({ action: "create", task: "Do the task", contextMode: "none", model: "test/model", effort: "high" });
  assert.equal(fixture.utilityPrompts.length, 0);
  assert.equal(fixture.compactions, 0);
  assert.equal(fixture.launches[0]?.classification, "explicit");
  assert.equal(fixture.launches[0]?.contextSummary, "");
});

test("default compaction failure still warns and launches fresh", async (t) => {
  const { execute } = await harness(t);
  fixture.failCompaction = true;
  const result = await execute({ action: "create", task: "Do the task", model: "test/model", effort: "high" });
  assert.equal(fixture.compactions, 1);
  assert.equal(Reflect.get(result.details, "compactionFallback"), true);
  assert.match(JSON.stringify(result.content), /Targeted compaction failed open/);
});

test("cancellation releases creation reservations in both modes and stops an aborted launch", async (t) => {
  for (const contextMode of ["task_compacted", "none"]) {
    const { execute } = await harness(t, contextMode === "none");
    for (let i = 0; i < 9; i++) {
      const abort = new AbortController();
      fixture.classify = async () => {
        abort.abort();
      };
      await assert.rejects(execute({ action: "create", task: "Do the task", contextMode }, abort.signal), /abort/i);
    }
    assert.equal(fixture.launches.length, 0);
    fixture.classify = undefined;
    const abort = new AbortController();
    fixture.start = async () => {
      abort.abort();
    };
    await assert.rejects(execute({ action: "create", task: "Do the task", contextMode }, abort.signal), /abort/i);
    assert.equal(fixture.stops, 1);
    fixture.start = undefined;
    await execute({ action: "create", task: "Do the task", contextMode });
    assert.equal(fixture.launches.length, 2);
  }
});

/** @param {import('node:test').TestContext} t */
async function waitHarness(t) {
  const harnessed = await harness(t, true);
  await harnessed.execute({
    action: "create",
    task: "task-echo-sentinel",
    contextMode: "none",
    model: "test/model",
    effort: "high",
  });
  const launch = fixture.launches[0];
  assert.ok(launch);
  fixture.snapshot = {
    state: "idle",
    turns: 3,
    toolCalls: 2,
    compactions: 1,
    transcriptTail: "working-text-sentinel\n→ bash tool-call-sentinel\nfinal-answer",
    stderr: "stderr-sentinel",
    classificationRationale: "task-echo-sentinel",
    currentTool: { name: "bash", argsPreview: "tool-call-sentinel", startedAt: 1 },
    lastAssistantText: "final-answer",
    finalAssistantText: "final-answer",
    stats: { tokens: { input: 10, output: 20, total: 30, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 },
  };
  return { ...harnessed, id: launch.id };
}

/** @param {Awaited<ReturnType<typeof harness>>['tool']} tool
 * @param {Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['execute']>>} result
 * @param {boolean} expanded */
function renderedResult(tool, result, expanded) {
  assert.ok(tool.renderResult);
  const theme = /** @type {Parameters<typeof tool.renderResult>[2]} */ (
    /** @type {unknown} */ ({
      fg: (/** @type {string} */ _color, /** @type {string} */ text) => text,
    })
  );
  const context = /** @type {Parameters<typeof tool.renderResult>[3]} */ (/** @type {unknown} */ ({}));
  return tool.renderResult(result, { expanded, isPartial: false }, theme, context).render(120).join("\n");
}

const privateWaitText =
  /task-echo-sentinel|working-text-sentinel|tool-call-sentinel|stderr-sentinel|transcript|argsPreview/;

test("settled wait returns only metadata and final text; status retains transcript diagnostics", async (t) => {
  const { execute, id, tool } = await waitHarness(t);
  const result = await execute({ action: "wait", id });
  assert.doesNotMatch(JSON.stringify(result), privateWaitText);
  assert.match(JSON.stringify(result.content), /final-answer/);
  const child = Reflect.get(result.details, "child");
  assert.equal(child.lastAssistantText, "final-answer");
  assert.deepEqual(child.stats, fixture.snapshot.stats);
  assert.equal(child.turns, 3);
  assert.equal(child.toolCalls, 2);
  for (const expanded of [true, false]) {
    const rendered = renderedResult(tool, result, expanded);
    assert.match(rendered, /final-answer/);
    assert.doesNotMatch(rendered, privateWaitText);
  }
  const status = await execute({ action: "status", id });
  assert.match(JSON.stringify(status), /task-echo-sentinel/);
  assert.match(JSON.stringify(status), /working-text-sentinel/);
  assert.match(JSON.stringify(status), /tool-call-sentinel/);
  assert.match(JSON.stringify(status), /stderr-sentinel/);
  assert.match(renderedResult(tool, status, true), /working-text-sentinel/);
  assert.equal(Reflect.get(status.details, "child").transcriptTail, fixture.snapshot.transcriptTail);
});

test("wait bounds final text in content and details and never falls back to transcript", async (t) => {
  const { execute, id } = await waitHarness(t);
  fixture.snapshot.finalAssistantText = `begin-${"x".repeat(60_000)}-end`;
  const result = await execute({ action: "wait", id });
  const final = Reflect.get(result.details, "child").lastAssistantText;
  assert.ok(final.length <= 45_000);
  assert.match(final, /^begin-/);
  assert.match(final, /-end$/);
  assert.ok(JSON.stringify(result.content).length < 46_000);
  assert.doesNotMatch(JSON.stringify(result), privateWaitText);
  for (const finalText of [undefined, "", "   "]) {
    if (finalText === undefined) delete fixture.snapshot.finalAssistantText;
    else fixture.snapshot.finalAssistantText = finalText;
    const empty = await execute({ action: "wait", id });
    assert.equal(Reflect.get(empty.details, "child").lastAssistantText, undefined);
    assert.doesNotMatch(JSON.stringify(empty), privateWaitText);
  }
});

test("settled wait never presents diagnostic-only assistant text as the final answer", async (t) => {
  const { execute, id } = await waitHarness(t);
  // Working text before a tool call, aborted partial text, or an earlier operation's answer.
  fixture.snapshot.lastAssistantText = "working-note-sentinel";
  delete fixture.snapshot.finalAssistantText;
  const result = await execute({ action: "wait", id });
  assert.equal(Reflect.get(result.details, "settled"), true);
  assert.equal(Reflect.get(result.details, "child").lastAssistantText, undefined);
  assert.doesNotMatch(JSON.stringify(result), /working-note-sentinel/);
});

test("timeout suppresses all partial text and a repeated wait can return the final answer", async (t) => {
  const { execute, id, tool } = await waitHarness(t);
  const abort = new AbortController();
  fixture.snapshot.state = "running";
  fixture.snapshot.finalAssistantText = "partial-answer-sentinel";
  fixture.wait = async (timeoutMs, signal) => {
    assert.equal(timeoutMs, 123);
    assert.equal(signal, abort.signal);
    return false;
  };
  const timeout = await execute({ action: "wait", id, timeoutMs: 123 }, abort.signal);
  assert.equal(Reflect.get(timeout.details, "settled"), false);
  assert.equal(Reflect.get(timeout.details, "child").lastAssistantText, undefined);
  assert.doesNotMatch(JSON.stringify(timeout), privateWaitText);
  assert.doesNotMatch(JSON.stringify(timeout), /partial-answer-sentinel/);
  assert.match(renderedResult(tool, timeout, true), /still active.*Wait again/);
  assert.doesNotMatch(renderedResult(tool, timeout, true), /partial-answer-sentinel/);
  assert.equal(fixture.stops, 0);
  fixture.wait = async (timeoutMs) => {
    assert.equal(timeoutMs, 120_000);
    return true;
  };
  fixture.snapshot.state = "idle";
  fixture.snapshot.finalAssistantText = "final-answer";
  const final = await execute({ action: "wait", id });
  assert.equal(Reflect.get(final.details, "settled"), true);
  assert.match(JSON.stringify(final.content), /final-answer/);
});

test("wait reports a failed child's error without its stderr diagnostics", async (t) => {
  const { execute, id } = await waitHarness(t);
  fixture.snapshot.state = "failed";
  fixture.snapshot.error =
    'Subagent process closed unexpectedly (child=x, pid=1, model=test/model, exitCode=17, signal=none, stderr="stderr-sentinel \\"quoted\\" detail").';
  const failed = await execute({ action: "wait", id });
  const error = Reflect.get(failed.details, "child").error;
  assert.equal(
    error,
    "Subagent process closed unexpectedly (child=x, pid=1, model=test/model, exitCode=17, signal=none).",
  );
  assert.doesNotMatch(JSON.stringify(failed), /stderr-sentinel/);
  const status = await execute({ action: "status", id });
  assert.match(JSON.stringify(status), /stderr-sentinel/, "status keeps the full diagnostic");
});

test("wait preserves terminal errors and cancellation without stopping the child", async (t) => {
  const { execute, id } = await waitHarness(t);
  fixture.snapshot.state = "failed";
  fixture.snapshot.error = "model failed";
  fixture.snapshot.finalAssistantText = "stale-final-sentinel";
  const failed = await execute({ action: "wait", id });
  assert.equal(Reflect.get(failed.details, "child").state, "failed");
  assert.match(JSON.stringify(failed.content), /model failed/);
  assert.doesNotMatch(JSON.stringify(failed), /stale-final-sentinel/);
  assert.doesNotMatch(JSON.stringify(failed), privateWaitText);
  fixture.snapshot.state = "stopped";
  const stopped = await execute({ action: "wait", id });
  assert.equal(Reflect.get(stopped.details, "child").state, "stopped");
  assert.doesNotMatch(JSON.stringify(stopped), /stale-final-sentinel/);
  fixture.snapshot.state = "idle";
  fixture.snapshot.pendingMessages = 1;
  delete fixture.snapshot.error;
  const queued = await execute({ action: "wait", id });
  assert.doesNotMatch(JSON.stringify(queued), /stale-final-sentinel/);
  const abort = new AbortController();
  fixture.wait = async (_timeoutMs, signal) => {
    assert.equal(signal, abort.signal);
    throw new Error("Subagent wait was aborted; the child is still running.");
  };
  abort.abort();
  await assert.rejects(execute({ action: "wait", id }, abort.signal), /wait was aborted/);
  assert.equal(fixture.stops, 0);
});

test("signaling spawn rejects extension-only models before constructing a child", async (t) => {
  const { ctx, lifecycle, events } = await harness(t, true);
  await lifecycle.session_start?.({}, ctx);
  for (const model of [
    { ...getModel("openai", "o3"), provider: "test", id: "model" },
    { ...getModel("openai", "o3"), id: "extension-only-model" },
    { ...getModel("openai", "o3"), api: "extension-only-api" },
    // Same provider, id, and API, but an extension-overridden endpoint.
    { ...getModel("openai", "o3"), baseUrl: "https://extension-proxy.invalid/v1" },
  ]) {
    ctx.modelRegistry.getAvailable = () => [model];
    const reply = await rpc(events, "spawn", {
      type: "general-purpose",
      prompt: "Generic TASK",
      options: {
        description: "extension-only",
        model: `${model.provider}/${model.id}`,
        thinkingLevel: "high",
        isolated: true,
        inheritContext: false,
      },
    });
    assert.equal(reply.success, false, JSON.stringify(reply));
    assert.match(String(reply.error), /isolated.*built-in.*extension/i);
    assert.equal(fixture.launches.length, 0, "reject before spawning any process");
  }
  await lifecycle.session_shutdown?.({}, ctx);
});

/** A promise with its resolver; the tsconfig lib predates Promise.withResolvers. */
function gate() {
  /** @type {((value: unknown) => void) | undefined} */
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve: (/** @type {unknown} */ value) => resolve?.(value) };
}

test("aborting a signaling spawn during child startup stops the new child at once", async (t) => {
  const { ctx, lifecycle, events } = await harness(t, true);
  const builtin = getModel("openai", "o3");
  const originalAvailable = ctx.modelRegistry.getAvailable;
  ctx.modelRegistry.getAvailable = () => [...originalAvailable(), builtin];
  await lifecycle.session_start?.({}, ctx);
  const startedGate = gate();
  const releaseGate = gate();
  fixture.start = async () => {
    startedGate.resolve(undefined);
    await releaseGate.promise;
  };
  const abort = new AbortController();
  const reply = rpc(events, "spawn", {
    type: "general-purpose",
    prompt: "Generic TASK",
    options: {
      description: "held-start",
      model: "openai/o3",
      thinkingLevel: "high",
      isolated: true,
      inheritContext: false,
      signal: abort.signal,
    },
  });
  await startedGate.promise;
  abort.abort();
  assert.equal(fixture.stops, 1, "the child is stopped while its startup RPC is still pending");
  releaseGate.resolve(undefined);
  const result = await reply;
  assert.equal(result.success, false);
  fixture.start = undefined;
  await lifecycle.session_shutdown?.({}, ctx);
});

test("signaling spawn launches an isolated task-only child with the explicit pair; tool defaults are unchanged", async (t) => {
  const { execute, ctx, lifecycle, events } = await harness(t, true);
  const builtin = getModel("openai", "o3");
  const originalAvailable = ctx.modelRegistry.getAvailable;
  ctx.modelRegistry.getAvailable = () => [...originalAvailable(), builtin];
  await lifecycle.session_start?.({}, ctx);
  assert.deepEqual(await rpc(events, "ping"), { success: true, data: { version: 2 } });
  const reply = await rpc(events, "spawn", {
    type: "general-purpose",
    prompt: "Generic TASK",
    options: {
      description: "token-1",
      model: "openai/o3",
      thinkingLevel: "high",
      isolated: true,
      inheritContext: false,
    },
  });
  assert.equal(reply.success, true, JSON.stringify(reply));
  const isolated = fixture.launches[0];
  assert.ok(isolated);
  assert.equal(fixture.utilityPrompts.length, 0, "explicit model+effort must skip the manager classifier");
  assert.equal(fixture.compactions, 0);
  assert.equal(isolated.classification, "explicit");
  assert.equal(isolated.model, "openai/o3");
  assert.equal(isolated.effort, "high");
  assert.equal(isolated.contextMode, "none");
  assert.equal(buildKickoffPrompt(isolated.task, isolated.contextSummary), "Task:\nGeneric TASK");
  for (const flag of [
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ])
    assert.ok(isolated.args.includes(flag), flag);
  for (const flag of ["--system-prompt", "--append-system-prompt"])
    assert.equal(isolated.args[isolated.args.indexOf(flag) + 1], "", `${flag} is overridden with an empty value`);
  const loaded = isolated.args.flatMap((arg, index) => (isolated.args[index - 1] === "--extension" ? [arg] : []));
  assert.equal(loaded.length, 1);
  assert.match(loaded[0] ?? "", /auth-bridge\.ts$/);

  // An unadvertised `isolated` argument on the ordinary tool is ignored.
  await execute({
    action: "create",
    task: "Ordinary",
    isolated: true,
    contextMode: "none",
    model: "test/model",
    effort: "high",
  });
  const ordinary = fixture.launches[1];
  assert.ok(ordinary);
  assert.equal(ordinary.args.includes("--no-extensions"), false, "ordinary tool must not gain resource isolation");
  assert.ok(
    ordinary.args.some((arg) => /index\.ts$/.test(arg)),
    "ordinary child keeps its manager extension",
  );
  await lifecycle.session_shutdown?.({}, ctx);
});
