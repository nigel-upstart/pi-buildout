import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManagedSubagent } from "./rpc.ts";

const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = dirname(dirname(packageEntry));
const piCli = join(packageRoot, "dist", "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./rpc.integration-provider.mjs", import.meta.url));
const timeoutMs = 30_000;

/** A tiny OpenAI-compatible streaming endpoint so this test needs no credentials or network. */
function createCompletionServer() {
  /** @type {unknown[]} */
  const requests = [];
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
    });
  });
  return { server, requests };
}

test("ManagedSubagent speaks Pi's real RPC protocol for prompt, follow-up, state, stats, and shutdown", async (t) => {
  const { server, requests } = createCompletionServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pi-subagent-rpc-integration-"));
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
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-session",
      "--approve",
    ],
    env: {
      ...process.env,
      PI_RPC_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      PI_RPC_TEST_API_KEY: "integration-test-only",
      PI_OFFLINE: "1",
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

  await child.followUp("Run the same deterministic follow-up");
  assert.equal(await child.waitForIdle(timeoutMs), true, "follow-up should settle through Pi RPC");
  await child.refresh();
  snapshot = child.snapshot();
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.turns, 2);
  assert.equal(snapshot.error, undefined);
  assert.equal(requests.length, 2);

  await child.stop();
  assert.equal(child.snapshot().state, "stopped", "stop should close the real Pi RPC process cleanly");
});
