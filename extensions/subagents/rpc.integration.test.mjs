import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManagedSubagent } from "./rpc.ts";
import { isolatedChildArgs } from "./signaling.ts";

const packageEntry =
  process.env.PI_TEST_PACKAGE_ENTRY ?? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = dirname(dirname(packageEntry));
const piCli = join(packageRoot, "dist", "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./rpc.integration-provider.mjs", import.meta.url));
const timeoutMs = 30_000;
const followUpMarker = "FOLLOW_UP_RPC_MARKER";
/** @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** @param {() => boolean} predicate @param {string} label */
async function waitFor(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A tiny OpenAI-compatible streaming endpoint so this test needs no credentials or network.
 * `holdNextResponse` keeps one completion in flight so the test can act while Pi is streaming.
 */
function createCompletionServer() {
  /** @type {unknown[]} */
  const requests = [];
  /** @type {(() => void)[]} */
  const held = [];
  let holdNext = false;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      if (holdNext) {
        holdNext = false;
        held.push(() => streamAnswer(response));
      } else streamAnswer(response);
    });
  });
  return {
    server,
    requests,
    holdNextResponse: () => {
      holdNext = true;
    },
    releaseHeld: () => {
      for (const respond of held.splice(0)) respond();
    },
  };
}

/** @param {import("node:http").ServerResponse} response */
function streamAnswer(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "rpc integration answer" } }] })}\n\n`,
  );
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("ManagedSubagent speaks Pi's real RPC protocol for prompt, follow-up, state, stats, and shutdown", async (t) => {
  const { server, requests, holdNextResponse, releaseHeld } = createCompletionServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-integration-"));
  const child = new ManagedSubagent({
    id: "piRpcIT001",
    name: "pi-rpc-integration",
    task: "Return the integration answer",
    model: "rpc-test/integration-model",
    effort: "off",
    contextSummary: "",
    cwd: tempDir,
    command: process.execPath,
    args: [
      piCli,
      "--mode",
      "rpc",
      "--session-dir",
      join(tempDir, "sessions"),
      "--name",
      "rpc-integration",
      "--model",
      "rpc-test/integration-model",
      "--thinking",
      "off",
      "--extension",
      providerExtension,
      ...isolatedChildArgs(fileURLToPath(new URL("./auth-bridge.ts", import.meta.url))),
      "--no-tools",
      "--no-session",
      "--approve",
    ],
    env: {
      ...process.env,
      PI_RPC_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      PI_RPC_TEST_API_KEY: "integration-test-only",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: join(tempDir, "agent"),
    },
    classification: "explicit",
  });
  t.after(async () => {
    await child.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  await child.start();
  assert.equal(await child.waitForIdle(timeoutMs), true, "initial prompt should settle through Pi RPC");
  await child.refresh();
  let snapshot = child.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.lastAssistantText, "rpc integration answer");
  assert.equal(snapshot.error, undefined);
  assert.ok(snapshot.stats, "get_session_stats should return actual Pi session stats");
  assert.equal(requests.length, 1, "Pi should make one request to the local deterministic provider");

  // An idle child is re-prompted with `prompt`. Hold that completion in flight so the next
  // followUp() runs while Pi is streaming and therefore sends the real `follow_up` RPC command.
  holdNextResponse();
  await child.followUp("Run a second deterministic prompt");
  await waitFor(() => requests.length === 2, "Pi to request the second completion");
  assert.equal(child.snapshot().state, "running", "the child must be streaming before follow_up");
  await child.followUp(`Queued follow-up ${followUpMarker}`);
  releaseHeld();
  await waitFor(() => {
    const current = child.snapshot();
    return requests.length >= 3 && current.turns >= 3 && current.state === "idle";
  }, "the queued follow_up turn to complete");
  assert.equal(requests.length, 3, "the queued follow_up should produce exactly one more model request");
  assert.match(JSON.stringify(requests[2]), new RegExp(followUpMarker), "follow_up text should reach the model");
  await child.refresh();
  snapshot = child.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.pendingMessages, 0, "Pi should report the follow_up queue as drained");
  assert.equal(snapshot.turns, 3);
  assert.equal(snapshot.lastAssistantText, "rpc integration answer");
  assert.equal(snapshot.error, undefined);

  await child.stop();
  assert.equal(child.snapshot().state, "stopped", "stop should close the real Pi RPC process cleanly");
});

test("isolated launch excludes ambient project/global extensions and context files that otherwise load", async (t) => {
  const { server, requests } = createCompletionServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-isolation-integration-"));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });
  const agentDir = join(tempDir, "agent");
  const projectSentinel = join(tempDir, "project-router-loaded");
  const globalSentinel = join(tempDir, "global-router-loaded");
  // Installed routers are usually configured through settings rather than discovered.
  const configuredSentinel = join(tempDir, "configured-router-loaded");
  /** @param {string} sentinel */
  const routerShaped = (sentinel) =>
    `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(sentinel)},'loaded')}`;
  await mkdir(join(tempDir, ".pi", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(tempDir, ".pi", "extensions", "router.ts"), routerShaped(projectSentinel));
  await writeFile(join(agentDir, "extensions", "router.ts"), routerShaped(globalSentinel));
  const configuredPath = join(tempDir, "configured", "router.ts");
  await mkdir(join(tempDir, "configured"), { recursive: true });
  await writeFile(configuredPath, routerShaped(configuredSentinel));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [configuredPath] }));
  await writeFile(join(tempDir, "AGENTS.md"), "AMBIENT_CONTEXT_FILE_MARKER\n");
  // Pi discovers these prompt files separately from context files.
  await writeFile(join(tempDir, ".pi", "SYSTEM.md"), "AMBIENT_SYSTEM_PROMPT_MARKER\n");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "AMBIENT_APPEND_PROMPT_MARKER\n");

  /** @param {string} id @param {string[]} resourceArgs */
  const runOnce = async (id, resourceArgs) => {
    const child = new ManagedSubagent({
      id,
      name: id,
      task: "Return the integration answer",
      model: "rpc-test/integration-model",
      effort: "off",
      contextSummary: "",
      cwd: tempDir,
      command: process.execPath,
      args: [
        piCli,
        "--mode",
        "rpc",
        "--model",
        "rpc-test/integration-model",
        "--thinking",
        "off",
        "--extension",
        providerExtension,
        ...resourceArgs,
        "--no-tools",
        "--no-session",
        "--approve",
      ],
      env: {
        ...process.env,
        PI_RPC_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_RPC_TEST_API_KEY: "integration-test-only",
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agentDir,
      },
      classification: "explicit",
    });
    try {
      await child.start();
      assert.equal(await child.waitForIdle(timeoutMs), true, `${id} should settle`);
      assert.equal(child.snapshot().lastAssistantText, "rpc integration answer");
    } finally {
      await child.stop();
    }
  };

  // Control: the same fixture loads ambient resources without the isolation flags,
  // so the isolated assertion below cannot pass vacuously.
  await runOnce("ambientCtl", []);
  assert.equal(await exists(projectSentinel), true, "control should load the project extension");
  assert.equal(await exists(globalSentinel), true, "control should load the global extension");
  assert.equal(await exists(configuredSentinel), true, "control should load the configured extension");
  assert.match(JSON.stringify(requests.at(-1)), /AMBIENT_CONTEXT_FILE_MARKER/);
  assert.match(JSON.stringify(requests.at(-1)), /AMBIENT_SYSTEM_PROMPT_MARKER/);
  assert.match(JSON.stringify(requests.at(-1)), /AMBIENT_APPEND_PROMPT_MARKER/);
  await rm(projectSentinel);
  await rm(globalSentinel);
  await rm(configuredSentinel);

  await runOnce("isolatedIT", isolatedChildArgs(fileURLToPath(new URL("./auth-bridge.ts", import.meta.url))));
  assert.equal(await exists(projectSentinel), false, "isolated child must not load project extensions");
  assert.equal(await exists(globalSentinel), false, "isolated child must not load global extensions");
  assert.equal(await exists(configuredSentinel), false, "isolated child must not load configured extensions");
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /AMBIENT_CONTEXT_FILE_MARKER/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /AMBIENT_SYSTEM_PROMPT_MARKER/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /AMBIENT_APPEND_PROMPT_MARKER/);
});
