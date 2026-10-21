import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { sdkFixture as fixture, stalledStream, streamMessage } from "./fixtures/pi-sdk.mjs";
import { inProcessReviewRunner } from "./review-runner.ts";

const scope = "a".repeat(64);
const verdict = {
  reviewKind: "plan",
  scopeFingerprint: scope,
  verdict: "approve",
  summary: "Bounded",
  evidence: ["Inspected plan"],
  findings: [],
};
function request(f) {
  return {
    cwd: f.cwd,
    registry: f.registry,
    model: f.model,
    effort: "off",
    kind: "plan",
    scopeFingerprint: scope,
    systemPrompt: "REVIEW_ONLY_SYSTEM",
    prompt: "Review this bounded task",
    timeoutMs: 5000,
    maxCost: 1,
  };
}

test("SDK reviewer uses parent model access, loads no resources, and exposes read-only plus verdict tools", async (t) => {
  const f = await fixture(t);
  const warmingModes = [];
  const getWarmingMode = SettingsManager.prototype.getCacheWarmingMode;
  t.mock.method(SettingsManager.prototype, "getCacheWarmingMode", function () {
    const mode = getWarmingMode.call(this);
    warmingModes.push(mode);
    return mode;
  });
  let calls = 0;
  const observed = [];
  f.respond = (model, context) => {
    observed.push(context);
    return calls++ === 0
      ? streamMessage(
          model,
          [{ type: "toolCall", id: "verdict", name: "submit_safety_review", arguments: verdict }],
          "toolUse",
        )
      : streamMessage(model, []);
  };
  const originalStream = f.runtime.streamSimple;
  const result = await inProcessReviewRunner.start(request(f)).result;
  assert.ok(calls > 0, JSON.stringify(result));
  assert.match(JSON.stringify(observed[0]), /REVIEW_ONLY_SYSTEM/);
  assert.doesNotMatch(JSON.stringify(observed[0]), /SHOULD_NOT_LOAD_RECURSIVELY/);
  assert.deepEqual(
    observed[0].messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.toolsAdded ?? [])
      .map((tool) => tool.name)
      .sort(),
    ["find", "grep", "ls", "read", "submit_safety_review"],
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.verdict, verdict);
  assert.equal(calls, 2, "requests went through the parent's authenticated runtime");
  assert.equal(result.usage.cost, 0.02);
  assert.equal(result.usage.inputTokens, 40);
  assert.ok(warmingModes.length > 0);
  assert.ok(
    warmingModes.every((mode) => mode === "off"),
    "review sessions must not issue unbudgeted cache-warming calls",
  );
  assert.equal(globalThis.__routerReviewerFactoryLoaded, undefined, "no router extension factory was loaded");
  assert.equal(
    f.runtime.streamSimple,
    originalStream,
    "the parent runtime request function is never wrapped or replaced",
  );
});

test("a real builder session keeps its model, effort, prompt, messages, and tools during review", async (t) => {
  const f = await fixture(t);
  const loader = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => "BUILDER_PROMPT",
  });
  await loader.reload();
  const { session: builder } = await createAgentSession({
    cwd: f.cwd,
    resourceLoader: loader,
    modelRuntime: f.runtime,
    model: f.model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(f.cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
  });
  t.after(() => builder.dispose());
  const snapshot = () => ({
    model: builder.model,
    effort: builder.thinkingLevel,
    prompt: builder.systemPrompt,
    messages: builder.messages,
    tools: builder.getActiveToolNames(),
  });
  const before = structuredClone(snapshot());
  let calls = 0;
  f.respond = (model, _context, options) => {
    assert.ok(options.maxTokens <= 4096);
    return calls++ === 0
      ? streamMessage(
          model,
          [
            {
              type: "toolCall",
              id: "verdict",
              name: "submit_safety_review",
              arguments: verdict,
            },
          ],
          "toolUse",
        )
      : streamMessage(model, []);
  };
  const result = await inProcessReviewRunner.start(request(f)).result;
  assert.equal(result.status, "completed");
  assert.deepEqual(snapshot(), before);
});

test("SDK reviewer skips safely when the private runtime field is unavailable", async () => {
  const result = await inProcessReviewRunner.start({
    registry: {},
    cwd: "/tmp",
    model: {},
    effort: "off",
    kind: "plan",
    scopeFingerprint: scope,
    systemPrompt: "",
    prompt: "",
    timeoutMs: 1000,
    maxCost: 1,
  }).result;
  assert.equal(result.status, "runtime_unavailable");
  assert.equal(result.verdict, undefined);
});

test("SDK reviewer cancels and times out a stalled provider", async (t) => {
  const f = await fixture(t);
  let aborted = 0;
  f.respond = (model, _context, options) =>
    stalledStream(model, options, () => {
      aborted++;
    });
  const handle = inProcessReviewRunner.start(request(f));
  await new Promise((resolve) => setTimeout(resolve, 30));
  handle.cancel();
  assert.equal((await handle.result).status, "cancelled");
  assert.equal((await inProcessReviewRunner.start({ ...request(f), timeoutMs: 30 }).result).status, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, 2);
});

test("SDK reviewer bounds spending and rejects prose-only or malformed verdicts", async (t) => {
  const f = await fixture(t);
  f.respond = (model) => streamMessage(model, [{ type: "text", text: "looks good" }]);
  assert.equal((await inProcessReviewRunner.start(request(f)).result).status, "failed");
  f.respond = (model) =>
    streamMessage(
      model,
      [
        {
          type: "toolCall",
          id: "invalid",
          name: "submit_safety_review",
          arguments: { ...verdict, scopeFingerprint: "b".repeat(64) },
        },
      ],
      "toolUse",
    );
  const bounded = await inProcessReviewRunner.start({ ...request(f), maxCost: 0.015 }).result;
  assert.equal(bounded.status, "budget_exceeded");
  assert.equal(bounded.verdict, undefined);
});

for (const reason of ["error", "aborted"]) {
  test(`SDK reviewer fails a valid verdict when the session then ends with stopReason ${reason}`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.runtime.streamSimple = (model) => {
      if (calls++ === 0)
        return streamMessage(
          model,
          [{ type: "toolCall", id: "verdict", name: "submit_safety_review", arguments: verdict }],
          "toolUse",
        );
      const stream = streamMessage(model, []);
      const failed = createAssistantMessageEventStream();
      // A provider failure after submission: Pi ends the run normally with an error/aborted assistant message.
      void stream.result().then((message) => {
        failed.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage: "fixture" } });
      });
      return failed;
    };
    const result = await inProcessReviewRunner.start(request(f)).result;
    assert.equal(calls, 2);
    assert.equal(result.status, "failed");
    assert.equal(result.verdict, undefined, "advice from a failed session is never delivered");
    assert.equal(result.usage.cost, 0.02, "usage from the failed message is still counted");
  });
}

test("SDK reviewer reports usage from the final aborted message after cancellation or timeout", async (t) => {
  const f = await fixture(t);
  f.runtime.streamSimple = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener(
      "abort",
      () => {
        // The in-flight request reports its partial spend only in the final aborted message.
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          stopReason: "aborted",
          timestamp: Date.now(),
          usage: {
            input: 30,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 35,
            cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
          },
        };
        setTimeout(() => stream.push({ type: "error", reason: "aborted", error: message }), 5);
      },
      { once: true },
    );
    return stream;
  };
  const handle = inProcessReviewRunner.start(request(f));
  await new Promise((resolve) => setTimeout(resolve, 30));
  handle.cancel();
  const cancelled = await handle.result;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.usage.cost, 0.03);
  assert.equal(cancelled.usage.inputTokens, 30);
  const timedOut = await inProcessReviewRunner.start({ ...request(f), timeoutMs: 30 }).result;
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.usage.cost, 0.03);
});

test("SDK reviewer starts no provider request when cancelled while prompt awaits authentication", async (t) => {
  const f = await fixture(t);
  let releaseAuth;
  const authChecked = new Promise((resolve) => {
    t.mock.method(f.runtime, "hasConfiguredAuth", () => false);
    t.mock.method(f.runtime, "checkAuth", () => {
      resolve();
      return new Promise((release) => {
        releaseAuth = () => release({ type: "api_key" });
      });
    });
  });
  let requests = 0;
  f.runtime.streamSimple = (model) => {
    requests++;
    return streamMessage(model, []);
  };
  const handle = inProcessReviewRunner.start(request(f));
  await authChecked;
  handle.cancel();
  assert.equal((await handle.result).status, "cancelled");
  releaseAuth();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 0, "a settled review must not start a paid request after authentication resolves");
});
