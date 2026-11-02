// Offline Pi SDK fixtures shared by the reviewer tests and the Pi contract canary. The provider is a
// registered custom API stream handler, so requests travel through Pi's real model runtime (auth
// resolution included) without any network connection or paid inference.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const noCredentials = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
};
let apiSequence = 0;

/**
 * A temporary workspace that would load AGENTS.md and a project router extension under normal
 * discovery, plus a model runtime with one offline provider. `f.respond` answers each request.
 */
export async function sdkFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "router-sdk-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "AGENTS.md"), "SHOULD_NOT_LOAD_RECURSIVELY");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "extensions", "router.ts"),
    "globalThis.__routerReviewerFactoryLoaded = true; export default () => {};",
  );
  const runtime = await ModelRuntime.create({ credentials: noCredentials, modelsPath: null, refreshOnCreate: false });
  const f = {
    cwd,
    runtime,
    registry: new ModelRegistry(runtime),
    requests: [],
    respond: () => {
      throw new Error("The offline fixture provider has no response configured");
    },
  };
  runtime.registerProvider("fixture", {
    // A unique custom API per fixture: no built-in transport can be selected, so nothing reaches a network.
    api: `router-offline-fixture-${++apiSequence}`,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "fixture-config-key",
    streamSimple: (model, context, options) => {
      f.requests.push({ model, context, options });
      return f.respond(model, context, options);
    },
    models: [
      { id: "review", name: "Review", input: ["text"], contextWindow: 100_000, maxTokens: 4096 },
      {
        id: "reasoning",
        name: "Reasoning",
        input: ["text"],
        reasoning: true,
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    ],
  });
  f.model = runtime.getModel("fixture", "review");
  f.reasoningModel = runtime.getModel("fixture", "reasoning");
  return f;
}

function usage(input, output, cost) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

/** A complete assistant response stream ending with one terminal `done` event. */
export function streamMessage(model, content, reason = "stop", cost = 0.01) {
  const message = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: reason,
    timestamp: Date.now(),
    usage: usage(20, 10, cost),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason, message });
  return stream;
}

/** A provider stream that stalls until its request is aborted, then reports an aborted message. */
export function stalledStream(model, options, onAbort = () => {}) {
  const stream = createAssistantMessageEventStream();
  options.signal.addEventListener(
    "abort",
    () => {
      onAbort();
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          stopReason: "aborted",
          errorMessage: "aborted",
          timestamp: Date.now(),
          usage: usage(0, 0, 0),
        },
      });
    },
    { once: true },
  );
  return stream;
}
