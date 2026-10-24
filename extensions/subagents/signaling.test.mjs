import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerSignaling } from "./signaling.ts";

/** @typedef {Record<string, any>} Payload */
/** Handlers only touch the context through the injected launcher. */
const ctx = /** @type {import("@earendil-works/pi-coding-agent").ExtensionContext} */ (/** @type {unknown} */ ({}));

/** @returns {any} */
function bus() {
  const emitter = new EventEmitter();
  return {
    emit: (/** @type {string} */ name, /** @type {unknown} */ value) => emitter.emit(name, value),
    on(/** @type {string} */ name, /** @type {(value: any) => void} */ callback) {
      emitter.on(name, callback);
      return () => emitter.off(name, callback);
    },
  };
}
/** @param {any} events @param {string} method @param {Payload} fields @returns {Promise<Payload>} */
function rpc(events, method, fields = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const off = events.on(`subagents:rpc:${method}:reply:${requestId}`, (/** @type {Payload} */ reply) => {
      off();
      resolve(reply);
    });
    events.emit(`subagents:rpc:${method}`, { requestId, ...fields });
  });
}
const request = () => ({
  type: "general-purpose",
  prompt: "TASK",
  options: {
    description: "TOKEN",
    model: "provider/model",
    thinkingLevel: "off",
    isolated: true,
    inheritContext: false,
  },
});
/**
 * @param {{ lastAssistantText?: string, finalAssistantText?: string }} texts
 * @returns {any}
 */
function child(texts = { lastAssistantText: "FINAL", finalAssistantText: "FINAL" }) {
  let stopped = false;
  return {
    id: "child",
    async waitForIdle() {
      return true;
    },
    async refresh() {},
    async stop() {
      stopped = true;
    },
    snapshot() {
      return { state: stopped ? "stopped" : "idle", ...texts, transcriptTail: "SECRET" };
    },
  };
}

test("protocol 2 ping is microtask replied; early final event is consumable synchronously", async () => {
  const events = bus();
  /** @type {Payload[]} */
  const terminal = [];
  /** @type {any} */
  let launch;
  const close = registerSignaling(events, ctx, async (args) => {
    launch = args;
    return child();
  });
  const ping = rpc(events, "ping");
  assert.deepEqual(await ping, { success: true, data: { version: 2 } });
  /** @type {Promise<Payload>[]} */
  const consumed = [];
  events.on("subagents:completed", (/** @type {Payload} */ value) => {
    terminal.push(value);
    consumed.push(rpc(events, "consume", { agentId: value.id }));
  });
  const reply = await rpc(events, "spawn", request());
  assert.deepEqual(reply, { success: true, data: { id: "child" } });
  await Promise.all(consumed);
  assert.equal(launch.contextMode, "none");
  assert.equal(launch.isolated, true);
  assert.equal(launch.effort, "off");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.result, "FINAL");
  assert.equal(JSON.stringify(terminal).includes("SECRET"), false);
  assert.deepEqual(await rpc(events, "consume", { agentId: "child" }), { success: true });
  await close();
});

test("a completed result carries only the operation's final answer, never diagnostic text", async () => {
  const events = bus();
  /** @type {Payload[]} */
  const terminal = [];
  // Working text before a tool call, then an empty final message: no final answer exists.
  const close = registerSignaling(events, ctx, async () => child({ lastAssistantText: "WORKING" }));
  events.on("subagents:completed", (/** @type {Payload} */ value) => terminal.push(value));
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && terminal.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.result, "");
  assert.equal(JSON.stringify(terminal).includes("WORKING"), false);
  await close();
});

test("shape errors and unknown ownership return error envelopes; missing requestId is ignored", async () => {
  const events = bus();
  let launches = 0;
  const close = registerSignaling(events, ctx, async () => {
    launches++;
    return child();
  });
  for (const bad of [
    {},
    { ...request(), type: "reviewer" },
    { ...request(), options: { ...request().options, isolated: false } },
  ]) {
    const reply = await rpc(events, "spawn", bad);
    assert.equal(reply.success, false);
    assert.doesNotMatch(reply.error, /^Error:/, "tintinweb envelopes carry the bare message");
  }
  assert.equal((await rpc(events, "stop", { agentId: "unknown" })).success, false);
  events.emit("subagents:rpc:spawn", request());
  assert.equal(launches, 0);
  await close();
  let answered = false;
  events.on("subagents:rpc:ping:reply:later", () => {
    answered = true;
  });
  events.emit("subagents:rpc:ping", { requestId: "later" });
  await Promise.resolve();
  assert.equal(answered, false);
});

test("pre-aborted spawn launches nothing; signal and stop terminate owned child", async () => {
  const events = bus();
  let launches = 0;
  let stops = 0;
  const close = registerSignaling(events, ctx, async () => {
    launches++;
    /** @type {(value: boolean) => void} */
    let release;
    const settled = new Promise((resolve) => {
      release = resolve;
    });
    return {
      ...child(),
      id: `child${String(launches)}`,
      // Like ManagedSubagent: aborting the wait rejects it but does not stop the child.
      waitForIdle: (/** @type {number} */ _timeout, /** @type {AbortSignal | undefined} */ signal) =>
        new Promise((resolve, reject) => {
          void settled.then(resolve);
          signal?.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
        }),
      stop: async () => {
        stops++;
        release(true);
      },
    };
  });
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await rpc(events, "spawn", { ...request(), options: { ...request().options, signal: controller.signal } }))
      .success,
    false,
  );
  assert.equal(launches, 0);
  /** @type {Payload[]} */
  const failed = [];
  events.on("subagents:failed", (/** @type {Payload} */ value) => {
    failed.push(value);
    void rpc(events, "consume", { agentId: value.id });
  });
  assert.deepEqual(await rpc(events, "spawn", request()), { success: true, data: { id: "child1" } });
  assert.deepEqual(await rpc(events, "stop", { agentId: "child1" }), { success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stops >= 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.status, "stopped");
  assert.equal(failed[0]?.result, "");
  assert.equal(failed[0]?.description, "TOKEN");
  assert.equal((await rpc(events, "stop", { agentId: "child1" })).error, "Agent is not running");

  const running = new AbortController();
  await rpc(events, "spawn", { ...request(), options: { ...request().options, signal: running.signal } });
  const before = stops;
  running.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stops > before, "signal abort stops the exact owned child");
  assert.equal(failed.length, 2);
  assert.equal(failed[1]?.id, "child2");
  assert.equal(failed[1]?.status, "aborted");
  await close();
});

test("consume before settlement is rejected and nothing emits after close", async () => {
  const events = bus();
  /** @type {((value: boolean) => void) | undefined} */
  let release;
  const close = registerSignaling(events, ctx, async () => ({
    ...child(),
    waitForIdle: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  }));
  /** @type {Payload[]} */
  const terminal = [];
  events.on("subagents:completed", (/** @type {Payload} */ value) => terminal.push(value));
  events.on("subagents:failed", (/** @type {Payload} */ value) => terminal.push(value));
  await rpc(events, "spawn", request());
  assert.equal((await rpc(events, "consume", { agentId: "child" })).error, "Agent not found or still running");
  const closing = close();
  assert.ok(release);
  release(true);
  await closing;
  assert.equal(terminal.length, 0);
});
