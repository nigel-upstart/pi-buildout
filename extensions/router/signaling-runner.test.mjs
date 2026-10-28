import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerSignaling, isolatedChildArgs } from "../subagents/signaling.ts";
import { parseReviewOutput } from "./review-output.ts";
import { createSignalingReviewRunner } from "./signaling-runner.ts";

const scope = "a".repeat(64);
const verdict = {
  reviewKind: "plan",
  scopeFingerprint: scope,
  verdict: "approve",
  summary: "Bounded",
  evidence: ["Inspected plan"],
  findings: [],
};
const request = (overrides = {}) => ({
  cwd: "/tmp",
  registry: {},
  model: { provider: "anthropic", id: "claude-opus-5-5" },
  effort: "high",
  kind: "plan",
  scopeFingerprint: scope,
  systemPrompt: "SYSTEM",
  prompt: "REVIEW_TASK",
  timeoutMs: 5_000,
  maxCost: 1,
  ...overrides,
});
const nonceOf = (prompt) => /nonce="([a-f0-9]{32})"/.exec(prompt)?.[1];
const block = (nonce, value = verdict) =>
  `Done.\n<router-result nonce="${nonce}">${JSON.stringify(value)}</router-result>`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Released tintinweb 0.22.0 shapes: `handleRpc` awaits the handler before replying (microtask),
 * `data` is omitted for void replies, and `buildEventData` carries Pi `Usage`.
 */
function releasedManager(bus, behavior = {}) {
  const seen = { pings: 0, spawns: [], consumeRequests: [], consumed: [], stops: [], notified: [] };
  const records = new Map();
  const handle = (method, fn) =>
    bus.on(`subagents:rpc:${method}`, async (raw) => {
      try {
        const data = await fn(raw);
        const reply = { success: true };
        if (data !== undefined) reply.data = data;
        bus.emit(`subagents:rpc:${method}:reply:${raw.requestId}`, reply);
      } catch (error) {
        bus.emit(`subagents:rpc:${method}:reply:${raw.requestId}`, { success: false, error: error.message });
      }
    });
  const terminal = (record, status, result) => {
    record.status = status;
    const failed = status !== "completed";
    bus.emit(failed ? "subagents:failed" : "subagents:completed", {
      id: record.id,
      type: "general-purpose",
      description: record.description,
      result,
      error: failed ? "Child failed" : undefined,
      status,
      toolUses: 1,
      durationMs: 10,
      tokens: { input: 10, output: 5, total: 15 },
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
    });
    // Released order: emit first, then decide whether to notify the parent.
    if (!record.resultConsumed) seen.notified.push(record.id);
  };
  handle("ping", () => {
    seen.pings++;
    if (behavior.ping === "error") throw new Error("No active session");
    return { version: behavior.version ?? 2 };
  });
  handle("spawn", async (raw) => {
    seen.spawns.push(raw);
    if (behavior.spawn === "error") throw new Error("Model not found");
    if (behavior.spawn === "bare-error") {
      // Malformed: protocol-2 error envelopes carry a string `error`.
      bus.emit(`subagents:rpc:spawn:reply:${raw.requestId}`, { success: false });
      await new Promise(() => {});
    }
    const record = {
      id: `agent-${String(seen.spawns.length)}`,
      description: raw.options.description,
      status: "running",
    };
    records.set(record.id, record);
    const nonce = nonceOf(raw.prompt);
    const finish = () =>
      behavior.terminal === "failed"
        ? terminal(record, "error", "")
        : terminal(record, "completed", behavior.result ?? block(nonce));
    if (behavior.early) finish();
    if (behavior.spawn === "lost") await new Promise(() => {});
    if (behavior.spawn === "malformed") return undefined;
    if (!behavior.early && behavior.terminal !== "never") queueMicrotask(finish);
    return { id: record.id };
  });
  handle("consume", ({ agentId }) => {
    seen.consumeRequests.push(agentId);
    const record = records.get(agentId);
    if (!record || record.status === "running") throw new Error("Agent not found or still running");
    record.resultConsumed = true;
    seen.consumed.push(agentId);
  });
  handle("stop", ({ agentId }) => {
    const record = records.get(agentId);
    if (!record) throw new Error("Agent not found");
    seen.stops.push(agentId);
    queueMicrotask(() => terminal(record, "stopped", ""));
  });
  return seen;
}

test("protocol 2: microtask ping, exact spawn envelope, and synchronous consume before notification", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus);
  const runner = createSignalingReviewRunner(bus);
  const result = await runner.start(request()).result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.verdict, verdict);
  assert.deepEqual(result.usage, { cost: 0.03, inputTokens: 12, outputTokens: 5 });
  const [spawn] = seen.spawns;
  assert.equal(spawn.type, "general-purpose");
  assert.match(spawn.requestId, /^[0-9a-f-]{36}$/);
  assert.match(spawn.prompt, /SYSTEM[\s\S]*REVIEW_TASK[\s\S]*router-result/);
  assert.deepEqual(Object.keys(spawn.options).sort(), [
    "description",
    "inheritContext",
    "isolated",
    "model",
    "signal",
    "thinkingLevel",
  ]);
  assert.equal(spawn.options.model, "anthropic/claude-opus-5-5");
  assert.equal(spawn.options.thinkingLevel, "high");
  assert.equal(spawn.options.isolated, true);
  assert.equal(spawn.options.inheritContext, false);
  assert.ok(spawn.options.signal instanceof AbortSignal);
  assert.deepEqual(seen.consumed, ["agent-1"]);
  assert.deepEqual(seen.notified, [], "consume landed before the manager's notification decision");
  assert.equal(runner.negative, undefined, "success is never cached");
});

test("early completion before the acceptance reply correlates by description and is consumed", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { early: true });
  const result = await createSignalingReviewRunner(bus).start(request()).result;
  assert.equal(result.status, "completed");
  assert.deepEqual(seen.consumed, ["agent-1"]);
  assert.deepEqual(seen.notified, []);
});

test("early terminal usage survives malformed acceptance without authorizing advice or replacement", async () => {
  for (const terminal of ["completed", "failed"]) {
    const bus = createEventBus();
    const seen = releasedManager(bus, { early: true, spawn: "malformed", terminal });
    const runner = createSignalingReviewRunner(bus);
    try {
      const result = await runner.start(request()).result;
      assert.equal(result.status, "uncertain", "a terminal cannot make malformed acceptance safe to replace");
      assert.equal(result.verdict, undefined, "even valid early advice is withheld");
      assert.deepEqual(seen.consumed, ["agent-1"]);
      assert.deepEqual(seen.notified, []);
      assert.equal(seen.spawns[0].options.signal.aborted, true);
      assert.equal(seen.spawns.length, 1, "never resent");
      assert.equal(runner.negative, undefined);
      assert.deepEqual(result.usage, { cost: 0.03, inputTokens: 12, outputTokens: 5 });
    } finally {
      await runner.dispose();
    }
  }
});

test("invalid or failed terminal output is still consumed and reported as confirmed failure", async () => {
  for (const behavior of [{ result: "no verdict block" }, { terminal: "failed" }, { result: block("0".repeat(32)) }]) {
    const bus = createEventBus();
    const seen = releasedManager(bus, behavior);
    const runner = createSignalingReviewRunner(bus);
    const result = await runner.start(request()).result;
    assert.equal(result.status, "failed");
    assert.equal(result.verdict, undefined);
    assert.deepEqual(seen.notified, []);
    assert.equal(runner.negative, undefined, "task failure never disables signaling");
  }
});

test("negative discovery caches only verified absence or incompatible protocol", async () => {
  const silent = createSignalingReviewRunner(createEventBus());
  assert.equal((await silent.start(request()).result).status, "unavailable");
  assert.equal(silent.negative, "no_responder");
  assert.equal((await silent.start(request()).result).status, "unavailable");

  const oldBus = createEventBus();
  const old = releasedManager(oldBus, { version: 1 });
  const incompatible = createSignalingReviewRunner(oldBus);
  assert.equal((await incompatible.start(request()).result).status, "unavailable");
  assert.equal(incompatible.negative, "unsupported_protocol");
  await incompatible.start(request()).result;
  assert.equal(old.pings, 1, "a valid negative cache skips later probes");

  const errorBus = createEventBus();
  const erroring = releasedManager(errorBus, { ping: "error" });
  const operational = createSignalingReviewRunner(errorBus);
  await operational.start(request()).result;
  await operational.start(request()).result;
  assert.equal(operational.negative, undefined);
  assert.equal(erroring.pings, 2, "operational errors are retried by the next review");

  const spawnBus = createEventBus();
  const spawnError = releasedManager(spawnBus, { spawn: "error" });
  const rejected = createSignalingReviewRunner(spawnBus);
  assert.equal((await rejected.start(request()).result).status, "unavailable");
  assert.equal(rejected.negative, undefined, "a spawn/provider error is not protocol evidence");
  assert.equal(spawnError.spawns.length, 1);
});

test("malformed acceptance is uncertain: abort, no resend, and a late terminal is still consumed", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { spawn: "malformed", terminal: "never" });
  const result = await createSignalingReviewRunner(bus).start(request()).result;
  assert.equal(result.status, "uncertain");
  assert.equal(seen.spawns.length, 1);
  assert.equal(seen.spawns[0].options.signal.aborted, true);
  bus.emit("subagents:completed", { id: "agent-1", description: seen.spawns[0].options.description, result: "late" });
  assert.deepEqual(seen.consumeRequests, ["agent-1"], "consume is sent synchronously for the late terminal");
  await tick();
});

test("an error envelope without a string error is uncertain, not a confirmed non-launch", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { spawn: "bare-error" });
  const result = await createSignalingReviewRunner(bus).start(request()).result;
  assert.equal(result.status, "uncertain");
  assert.equal(seen.spawns[0].options.signal.aborted, true);
});

test("shutdown right after cancellation drains briefly so the stop terminal is consumed", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { terminal: "never" });
  const runner = createSignalingReviewRunner(bus);
  const handle = runner.start(request());
  for (let i = 0; i < 20 && seen.spawns.length === 0; i++) await tick();
  await tick();
  handle.cancel();
  await runner.dispose();
  assert.deepEqual(seen.stops, ["agent-1"]);
  assert.deepEqual(seen.consumed, ["agent-1"]);
  assert.deepEqual(seen.notified, []);
});

test("a closing tag quoted inside a JSON string does not truncate the verdict", () => {
  const nonce = "1".repeat(32);
  const quoted = { ...verdict, findings: ['The child echoed "</router-result>" and a brace } in prose'] };
  assert.deepEqual(parseReviewOutput(block(nonce, quoted), nonce), quoted);
  assert.equal(parseReviewOutput(`<router-result nonce="${nonce}">{"a":1} trailing</router-result>`, nonce), undefined);
});

test("disposal after a cancelled, lost acceptance releases every reply listener and timer", async () => {
  const inner = createEventBus();
  let subscriptions = 0;
  const bus = {
    emit: (channel, data) => inner.emit(channel, data),
    on(channel, handler) {
      subscriptions++;
      const off = inner.on(channel, handler);
      return () => {
        subscriptions--;
        off();
      };
    },
  };
  const seen = releasedManager(bus, { spawn: "lost" });
  const baseline = subscriptions;
  const runner = createSignalingReviewRunner(bus);
  const handle = runner.start(request());
  for (let i = 0; i < 20 && seen.spawns.length === 0; i++) await tick();
  handle.cancel();
  const started = Date.now();
  await runner.dispose();
  assert.ok(Date.now() - started < 5_000, "bounded by the drain, not the 120-second spawn wait");
  assert.equal(subscriptions, baseline, "only the manager's own handlers remain");
  assert.equal(seen.spawns.length, 1, "never resent");
});

test("lost acceptance at the deadline aborts without resend and consumes the late terminal", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { spawn: "lost" });
  const runner = createSignalingReviewRunner(bus);
  const result = await runner.start(request({ timeoutMs: 30 })).result;
  assert.equal(result.status, "timeout");
  assert.equal(seen.spawns.length, 1);
  assert.equal(seen.spawns[0].options.signal.aborted, true);
  bus.emit("subagents:failed", { id: "agent-1", description: seen.spawns[0].options.description, status: "aborted" });
  assert.deepEqual(seen.consumeRequests, ["agent-1"]);
  assert.equal(seen.spawns.length, 1, "never resent");
  runner.dispose();
});

test("cancellation stops the owned child, ignores its stale result, and consumes the stop terminal", async () => {
  const bus = createEventBus();
  const seen = releasedManager(bus, { terminal: "never" });
  const handle = createSignalingReviewRunner(bus).start(request());
  for (let i = 0; i < 20 && seen.spawns.length === 0; i++) await tick();
  await tick();
  handle.cancel();
  const result = await handle.result;
  assert.equal(result.status, "cancelled");
  for (let i = 0; i < 20 && seen.consumed.length === 0; i++) await tick();
  assert.deepEqual(seen.stops, ["agent-1"]);
  assert.equal(seen.spawns[0].options.signal.aborted, true);
  assert.deepEqual(seen.consumed, ["agent-1"], "the stop terminal is consumed, not notified");
  assert.deepEqual(seen.notified, []);
});

test("cancellation and timeout keep the stale status but report the stop terminal's billed usage", async () => {
  for (const ending of ["cancelled", "timeout"]) {
    const bus = createEventBus();
    const seen = releasedManager(bus, { terminal: "never" });
    const handle = createSignalingReviewRunner(bus).start(request(ending === "timeout" ? { timeoutMs: 60 } : {}));
    for (let i = 0; i < 20 && seen.spawns.length === 0; i++) await tick();
    await tick();
    if (ending === "cancelled") handle.cancel();
    const result = await handle.result;
    assert.equal(result.status, ending);
    assert.equal(result.verdict, undefined, "stale advice is never delivered");
    assert.deepEqual(seen.stops, ["agent-1"]);
    assert.equal(result.usage.cost, 0.03, `${ending} keeps the spend reported at termination`);
    assert.equal(seen.spawns.length, 1, "never relaunched");
  }
});

test("lost acceptance retains billed usage before and during the bounded stale drain", async () => {
  for (const ending of ["cancelled", "timeout"]) {
    for (const early of [true, false]) {
      const bus = createEventBus();
      const seen = releasedManager(bus, { spawn: "lost", terminal: "never", early });
      const runner = createSignalingReviewRunner(bus);
      const handle = runner.start(request(ending === "timeout" ? { timeoutMs: 60 } : {}));
      try {
        for (let i = 0; i < 50 && seen.spawns.length === 0; i++) await tick();
        assert.equal(seen.spawns.length, 1);
        await tick();
        if (ending === "cancelled") handle.cancel();
        if (!early) {
          // For timeout this also lets the spawn RPC's own timeout arrive before the terminal.
          await new Promise((resolve) => setTimeout(resolve, 120));
          bus.emit("subagents:failed", {
            id: "agent-1",
            description: seen.spawns[0].options.description,
            status: "aborted",
            usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.03 } },
          });
        }
        const result = await handle.result;
        assert.equal(result.status, ending);
        assert.equal(result.verdict, undefined, "stale, unaccepted advice never reaches the builder");
        assert.deepEqual(result.usage, { cost: 0.03, inputTokens: 12, outputTokens: 5 });
        assert.deepEqual(seen.consumeRequests, ["agent-1"]);
        assert.equal(seen.spawns.length, 1, "lost acceptance never starts a replacement");
      } finally {
        await runner.dispose();
      }
    }
  }
});

test("missing terminal bounds the stale usage drain and still consumes a terminal arriving afterwards", async () => {
  for (const ending of ["cancelled", "timeout"]) {
    const bus = createEventBus();
    const seen = releasedManager(bus, { spawn: "lost", terminal: "never" });
    const runner = createSignalingReviewRunner(bus);
    const handle = runner.start(request(ending === "timeout" ? { timeoutMs: 60 } : {}));
    try {
      for (let i = 0; i < 50 && seen.spawns.length === 0; i++) await tick();
      assert.equal(seen.spawns.length, 1);
      const started = Date.now();
      if (ending === "cancelled") handle.cancel();
      const result = await handle.result;
      assert.equal(result.status, ending);
      assert.ok(Date.now() - started >= 900, "waits for the usage grace, not just the spawn timeout");
      assert.ok(Date.now() - started < 3_000, "never waits for the 120-second acceptance deadline");
      assert.deepEqual(result.usage, { cost: 0, inputTokens: 0, outputTokens: 0 });
      bus.emit("subagents:failed", {
        id: "agent-1",
        description: seen.spawns[0].options.description,
        status: "aborted",
        usage: { cost: { total: 0.03 } },
      });
      assert.deepEqual(seen.consumeRequests, ["agent-1"], "late terminals remain synchronously consumed");
      assert.equal(result.usage.cost, 0, "the already-settled result is immutable");
      assert.equal(seen.spawns.length, 1);
    } finally {
      await runner.dispose();
    }
  }
});

test("contract: a failed P2 child is reported only after cleanup completes", async () => {
  const bus = createEventBus();
  let finishStop;
  const stopped = new Promise((resolve) => {
    finishStop = resolve;
  });
  let stopCalls = 0;
  const close = registerSignaling(bus, /** @type {any} */ ({}), async () => ({
    id: "ours",
    waitForIdle: async () => true,
    refresh: async () => {},
    stop: () => {
      stopCalls++;
      return stopped;
    },
    snapshot: () => ({ state: "failed", error: "model failed", transcriptTail: "PRIVATE" }),
  }));
  const runner = createSignalingReviewRunner(bus);
  try {
    let settled = false;
    const pending = runner.start(request()).result.then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; i < 50 && stopCalls === 0; i++) await tick();
    assert.equal(stopCalls, 1);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(settled, false, "no terminal is available while process cleanup is pending");
    finishStop();
    assert.equal((await pending).status, "failed");
  } finally {
    finishStop();
    await close();
    await runner.dispose();
  }
});

test("contract: this repository's P2 handler serves the router adapter with an isolated child", async () => {
  const bus = createEventBus();
  const launches = [];
  const close = registerSignaling(bus, /** @type {any} */ ({}), async (args) => {
    launches.push(args);
    let stopped = false;
    return {
      id: "ours",
      waitForIdle: async () => true,
      refresh: async () => {},
      stop: async () => {
        stopped = true;
      },
      snapshot: () => ({
        state: stopped ? "stopped" : "idle",
        lastAssistantText: block(nonceOf(args.task)),
        finalAssistantText: block(nonceOf(args.task)),
        transcriptTail: "PRIVATE",
      }),
    };
  });
  try {
    const result = await createSignalingReviewRunner(bus).start(request()).result;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.verdict, verdict);
    assert.equal(launches[0].model, "anthropic/claude-opus-5-5");
    assert.equal(launches[0].effort, "high");
    assert.equal(launches[0].isolated, true);
    assert.equal(launches[0].contextMode, "none");
    // The actual child launch suppresses ambient extensions, so no router loads in it.
    assert.ok(isolatedChildArgs("/auth-bridge.ts").includes("--no-extensions"));
  } finally {
    await close();
  }
});
