#!/usr/bin/env node
/**
 * Probe every scoped model with a minimal real request and record which endpoints work.
 *
 * "Scoped" means the `enabledModels` patterns in pi settings — the same set the model selector
 * offers. The router's candidate pool is derived from that scope, so an endpoint that is scoped but
 * broken on this machine should be excluded from routing rather than discovered mid-task.
 *
 * The probe writes a health record consumed by extensions/router/core/health.ts. It records the
 * observed outcome per endpoint and never guesses: an endpoint that could not be probed is recorded
 * as `unknown`, which the router treats as usable, because absence of evidence is not evidence of
 * failure.
 *
 * Usage:
 *   node scripts/probe-scoped-models.mjs [--out <path>] [--concurrency <n>] [--timeout <seconds>]
 *   node scripts/probe-scoped-models.mjs --dry-run    # list the scope without calling anything
 */

import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const PROMPT = "Reply with exactly: PROBE_OK";
const EXPECTED = "PROBE_OK";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    concurrency: { type: "string", default: "4" },
    timeout: { type: "string", default: "120" },
    "dry-run": { type: "boolean", default: false },
  },
});

const outPath = values.out ?? join(homedir(), ".pi", "agent", "router-endpoint-health.json");
const concurrency = Math.max(1, Number.parseInt(values.concurrency, 10) || 4);
const timeoutMs = (Number.parseInt(values.timeout, 10) || 120) * 1000;

async function readSettings(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** Scope patterns, project settings first so a project can narrow the probe. */
async function scopePatterns() {
  const project = await readSettings(join(process.cwd(), ".pi", "settings.json"));
  const user = await readSettings(join(homedir(), ".pi", "agent", "settings.json"));
  return project.enabledModels ?? user.enabledModels ?? [];
}

function listModels() {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["--list-models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => {
      const rows = out
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map(([provider, modelId]) => `${provider}/${modelId}`);
      resolve(new Set(rows));
    });
  });
}

/**
 * Classify a failure into something actionable. A 4xx is a configuration or capability problem that
 * will recur; a 5xx or timeout may be transient. The router treats them differently.
 */
function classify(stdout, stderr, code, timedOut) {
  const text = `${stdout}\n${stderr}`;
  if (stdout.includes(EXPECTED)) return { status: "ok" };
  if (timedOut) return { status: "timeout", detail: `no response within ${timeoutMs / 1000}s` };
  const httpStatus = /\b(4\d{2}|5\d{2})\b/.exec(text)?.[1];
  if (httpStatus) {
    const numeric = Number.parseInt(httpStatus, 10);
    return {
      status: numeric >= 500 ? "server_error" : "client_error",
      httpStatus: numeric,
      detail: firstMeaningfulLine(text),
    };
  }
  if (/not authenticated|no api key|unauthorized|credential|oauth/i.test(text)) {
    return { status: "client_error", detail: "authentication is not configured" };
  }
  if (/unknown model|not found in registry|no model matching/i.test(text)) {
    return { status: "client_error", detail: "model is absent from the registry" };
  }
  return { status: "failed", detail: firstMeaningfulLine(text) || `exit code ${String(code)}` };
}

function firstMeaningfulLine(text) {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0 && !line.startsWith("PROBE"))
      ?.slice(0, 200) ?? ""
  );
}

function probe(reference) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pi", ["--no-session", "--no-tools", "--no-extensions", "--model", reference, "-p", PROMPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ reference, status: "failed", detail: error.message, latencyMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        reference,
        ...classify(stdout, stderr, code, timedOut),
        latencyMs: Date.now() - started,
      });
    });
  });
}

async function main() {
  const patterns = await scopePatterns();
  if (patterns.length === 0) {
    console.error("No enabledModels patterns found; nothing is scoped. Nothing to probe.");
    process.exit(1);
  }
  const registry = await listModels();
  // Only exact provider/id patterns are probed. A glob pattern is reported so the operator knows the
  // probe did not cover it, rather than the probe silently expanding it differently than pi would.
  const exact = patterns.filter((pattern) => registry.has(pattern));
  const unmatched = patterns.filter((pattern) => !registry.has(pattern));

  console.log(`scoped patterns: ${String(patterns.length)}`);
  console.log(`probing exact endpoints: ${String(exact.length)}`);
  if (unmatched.length > 0) {
    console.log(`not probed (glob, or absent from the registry): ${String(unmatched.length)}`);
    for (const pattern of unmatched) console.log(`  - ${pattern}`);
  }
  if (values["dry-run"]) return;

  const results = [];
  const queue = [...exact];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const result = await probe(next);
        results.push(result);
        const mark = result.status === "ok" ? "ok  " : "FAIL";
        console.log(
          `  ${mark} ${result.reference.padEnd(58)} ${String(result.latencyMs).padStart(6)}ms ${result.status === "ok" ? "" : `${result.status}: ${result.detail ?? ""}`}`,
        );
      }
    }),
  );

  results.sort((left, right) => left.reference.localeCompare(right.reference));
  const record = {
    schemaVersion: 1,
    probedAt: new Date().toISOString(),
    prompt: PROMPT,
    endpoints: results.map((result) => {
      const [provider, ...rest] = result.reference.split("/");
      return {
        provider,
        modelId: rest.join("/"),
        status: result.status,
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.detail === undefined || result.detail === "" ? {} : { detail: result.detail }),
        latencyMs: result.latencyMs,
      };
    }),
    unprobedPatterns: unmatched,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);

  const failed = results.filter((result) => result.status !== "ok");
  console.log(`\nworking: ${String(results.length - failed.length)}/${String(results.length)}`);
  console.log(`wrote ${outPath}`);
  if (failed.length > 0) {
    console.log("\nexcluded from routing until re-probed:");
    for (const result of failed) console.log(`  ${result.reference} (${result.status})`);
  }
}

await main();
