import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SUBAGENT_NOTIFICATION_TYPE, registerSignaling } from "./signaling.ts";

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

test("a failed child's terminal is published only after its cleanup finishes", async () => {
  const events = bus();
  /** @type {Payload[]} */
  const terminal = [];
  /** @type {((value?: unknown) => void) | undefined} */
  let finishStop;
  const stopped = new Promise((resolve) => {
    finishStop = resolve;
  });
  let stopCalls = 0;
  /** @type {any} */
  const failedChild = {
    id: "child",
    async waitForIdle() {
      return true;
    },
    async refresh() {},
    stop() {
      stopCalls++;
      return stopped;
    },
    snapshot() {
      return { state: "failed", error: "model failed", transcriptTail: "" };
    },
  };
  const close = registerSignaling(events, ctx, async () => failedChild);
  events.on("subagents:failed", (/** @type {Payload} */ value) => terminal.push(value));
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && stopCalls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const publishedDuringCleanup = terminal.length;
  finishStop?.();
  for (let i = 0; i < 50 && terminal.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await close();
  assert.equal(publishedDuringCleanup, 0, "no failure is published while process cleanup is pending");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.status, "error");
});

/** A deterministic async boundary without timer-based scheduling assumptions. */
function gate() {
  /** @type {(() => void) | undefined} */
  let resolve;
  /** @type {Promise<void>} */
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

for (const cancellation of ["none", "abort", "stop", "stop then abort", "close"]) {
  test(`cancellation during cleanup: ${cancellation}`, { timeout: 5000 }, async (t) => {
    const events = bus();
    const controller = new AbortController();
    const cleanupStarted = gate();
    const cleanupFinished = gate();
    /** @type {Payload[]} */
    const terminal = [];
    let stopped = false;
    const close = registerSignaling(events, ctx, async () => ({
      ...child(),
      stop() {
        stopped = true;
        cleanupStarted.resolve();
        return cleanupFinished.promise;
      },
      snapshot() {
        return { state: stopped ? "stopped" : "idle", finalAssistantText: "FINAL" };
      },
    }));
    t.after(async () => {
      cleanupFinished.resolve();
      await close();
    });
    events.on("subagents:completed", (/** @type {Payload} */ value) => terminal.push(value));
    events.on("subagents:failed", (/** @type {Payload} */ value) => terminal.push(value));
    await rpc(events, "spawn", { ...request(), options: { ...request().options, signal: controller.signal } });
    await cleanupStarted.promise;
    assert.equal(terminal.length, 0, "no terminal until process cleanup finishes");
    assert.equal((await rpc(events, "consume", { agentId: "child" })).success, false);

    /** @type {Promise<Payload> | undefined} */
    let stopReply;
    if (cancellation.startsWith("stop")) {
      stopReply = rpc(events, "stop", { agentId: "child" });
      assert.equal((await rpc(events, "stop", { agentId: "child" })).success, false);
    }
    if (cancellation.includes("abort")) controller.abort();
    const closing = cancellation === "close" ? close() : undefined;
    assert.equal(terminal.length, 0, "cancellation must not publish before cleanup either");
    cleanupFinished.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    if (stopReply) assert.deepEqual(await stopReply, { success: true });
    if (closing) {
      await closing;
      assert.equal(terminal.length, 0, "closing suppresses publication entirely");
      return;
    }
    const status = cancellation.includes("abort") ? "aborted" : cancellation === "stop" ? "stopped" : "completed";
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, status);
    assert.equal(terminal[0]?.result, status === "completed" ? "FINAL" : "");
    assert.deepEqual(await rpc(events, "consume", { agentId: "child" }), { success: true });
    assert.equal((await rpc(events, "stop", { agentId: "child" })).error, "Agent is not running");
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminal.length, 1, "published terminal states are immutable");
    assert.equal(terminal[0]?.status, status);
  });
}

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

test("unconsumed completed child pushes result message to parent session and notifies UI", async () => {
  const events = bus();
  /** @type {{ msg: string, level: string }[]} */
  const notifications = [];
  /** @type {Payload[]} */
  const sent = [];
  const testCtx = /** @type {any} */ ({
    ui: {
      notify(/** @type {string} */ msg, /** @type {string} */ level) {
        notifications.push({ msg, level });
      },
    },
  });
  const testPi = /** @type {any} */ ({
    sendMessage(/** @type {any} */ msg, /** @type {any} */ opts) {
      sent.push({ msg, opts });
    },
  });
  const close = registerSignaling(events, testCtx, async () => child({ finalAssistantText: "ALL DONE" }), {
    pi: testPi,
  });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.msg.customType, SUBAGENT_NOTIFICATION_TYPE);
  assert.equal(sent[0]?.msg.details.status, "completed");
  assert.ok(sent[0]?.msg.details.result);
  assert.deepEqual(sent[0]?.opts, { deliverAs: "followUp", triggerTurn: true });

  await close();
});

test("unconsumed failed child pushes error message to parent session", async () => {
  const events = bus();
  /** @type {{ msg: string, level: string }[]} */
  const notifications = [];
  /** @type {Payload[]} */
  const sent = [];
  const testCtx = /** @type {any} */ ({
    ui: {
      notify(/** @type {string} */ msg, /** @type {string} */ level) {
        notifications.push({ msg, level });
      },
    },
  });
  const testPi = /** @type {any} */ ({
    sendMessage(/** @type {any} */ msg, /** @type {any} */ opts) {
      sent.push({ msg, opts });
    },
  });
  let stopped = false;
  const failedChild = {
    id: "failed-child",
    async waitForIdle() {
      return true;
    },
    async refresh() {},
    async stop() {
      stopped = true;
    },
    snapshot() {
      return { state: stopped ? "stopped" : "failed", error: "Connection reset", transcriptTail: "" };
    },
  };
  const close = registerSignaling(events, testCtx, async () => /** @type {any} */ (failedChild), { pi: testPi });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.msg.customType, SUBAGENT_NOTIFICATION_TYPE);
  assert.equal(sent[0]?.msg.details.status, "error");
  assert.ok(sent[0]?.msg.details.error);

  await close();
});

test("consumed child suppresses parent session message and UI notification", async () => {
  const events = bus();
  /** @type {{ msg: string, level: string }[]} */
  const notifications = [];
  /** @type {Payload[]} */
  const sent = [];
  const testCtx = /** @type {any} */ ({
    ui: {
      notify(/** @type {string} */ msg, /** @type {string} */ level) {
        notifications.push({ msg, level });
      },
    },
  });
  const testPi = /** @type {any} */ ({
    sendMessage(/** @type {any} */ msg, /** @type {any} */ opts) {
      sent.push({ msg, opts });
    },
  });
  events.on("subagents:completed", (/** @type {Payload} */ value) => {
    void rpc(events, "consume", { agentId: value.id });
  });
  const close = registerSignaling(events, testCtx, async () => child({ finalAssistantText: "CLAIMED BY ROUTER" }), {
    pi: testPi,
  });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2));

  assert.equal(notifications.length, 0, "consumed result must not notify UI");
  assert.equal(sent.length, 0, "consumed result must not push message to parent session");

  await close();
});

test("pushed parent message is bounded and stderr-free while the signaling event keeps the full payload", async () => {
  const events = bus();
  /** @type {Payload[]} */
  const sent = [];
  /** @type {Payload[]} */
  const terminal = [];
  events.on("subagents:completed", (/** @type {Payload} */ value) => terminal.push(value));
  events.on("subagents:failed", (/** @type {Payload} */ value) => terminal.push(value));
  const testPi = /** @type {any} */ ({
    sendMessage(/** @type {any} */ msg) {
      sent.push(msg);
    },
  });
  const long = "begin-" + "x".repeat(60_000) + "-end";
  const close = registerSignaling(events, ctx, async () => child({ finalAssistantText: long }), { pi: testPi });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(terminal[0]?.result, long, "consumers still receive the full result");
  assert.ok(sent[0]?.details.result.length <= 45_000);
  assert.match(sent[0]?.details.result, /^begin-/);
  assert.match(sent[0]?.details.result, /-end$/);
  assert.ok(sent[0]?.content.length < 46_000);
  await close();

  const failing = {
    ...child(),
    snapshot() {
      return {
        state: "failed",
        error: 'Subagent process closed unexpectedly (exitCode=1, stderr="stderr-sentinel").',
        transcriptTail: "",
      };
    },
  };
  sent.length = 0;
  terminal.length = 0;
  const closeFailed = registerSignaling(events, ctx, async () => failing, { pi: testPi });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.match(terminal[0]?.error, /stderr-sentinel/, "consumers keep the full diagnostic");
  assert.doesNotMatch(JSON.stringify(sent), /stderr-sentinel/);
  assert.match(sent[0]?.content, /closed unexpectedly/);
  await closeFailed();
});

test("a throwing parent delivery never rejects the signaling watcher", async () => {
  const events = bus();
  /** @type {Payload[]} */
  const terminal = [];
  events.on("subagents:completed", (/** @type {Payload} */ value) => terminal.push(value));
  const throwingCtx = /** @type {any} */ ({
    ui: {
      notify() {
        throw new Error("stale ctx");
      },
    },
  });
  const throwingPi = /** @type {any} */ ({
    sendMessage() {
      throw new Error("stale pi");
    },
  });
  const close = registerSignaling(events, throwingCtx, async () => child(), { pi: throwingPi });
  await rpc(events, "spawn", request());
  for (let i = 0; i < 50 && terminal.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(terminal.length, 1);
  await close();
});

test("a caller's own stop or abort emits the failed event but pushes nothing to the parent session", async () => {
  const events = bus();
  /** @type {{ msg: string, level: string }[]} */
  const notifications = [];
  /** @type {Payload[]} */
  const sent = [];
  const testCtx = /** @type {any} */ ({
    ui: {
      notify(/** @type {string} */ msg, /** @type {string} */ level) {
        notifications.push({ msg, level });
      },
    },
  });
  const testPi = /** @type {any} */ ({
    sendMessage(/** @type {any} */ msg) {
      sent.push(msg);
    },
  });
  const ids = ["cancel1", "cancel2"];
  const close = registerSignaling(
    events,
    testCtx,
    async () => {
      /** @type {(value: boolean) => void} */
      let release;
      const settled = new Promise((resolve) => {
        release = resolve;
      });
      return {
        ...child(),
        id: ids.shift(),
        waitForIdle: (/** @type {number} */ _timeout, /** @type {AbortSignal | undefined} */ signal) =>
          new Promise((resolve, reject) => {
            void settled.then(resolve);
            signal?.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
          }),
        stop: async () => {
          release(true);
        },
      };
    },
    { pi: testPi },
  );
  /** @type {Payload[]} */
  const failed = [];
  // No consume: the caller relies on its own control request rather than claiming the result.
  events.on("subagents:failed", (/** @type {Payload} */ value) => failed.push(value));

  await rpc(events, "spawn", request());
  assert.deepEqual(await rpc(events, "stop", { agentId: "cancel1" }), { success: true });
  const running = new AbortController();
  await rpc(events, "spawn", { ...request(), options: { ...request().options, signal: running.signal } });
  running.abort();
  for (let i = 0; i < 50 && failed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));

  assert.deepEqual(
    failed.map((event) => event.status),
    ["stopped", "aborted"],
  );
  assert.equal(sent.length, 0, "caller-initiated cancellation must not start a parent turn");
  assert.equal(notifications.length, 0);
  await close();
});
