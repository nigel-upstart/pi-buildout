/**
 * Safety-gate calibration eval against the live classifier.
 *
 * Runs every prompt in `corpus/safety.json` through the same path live routing uses: the scoped Pi
 * model registry, `classifyTaskWithPi` (primary classifier, plus the provider-diverse secondary when
 * the primary escalates), then `deriveSafetyPolicy`. Each case asserts whether the irreversible-action
 * preflight gate fires, plus the acceptable `actionMode`, `risk`, and `workflowType` values.
 *
 * Credentials come from Pi's own auth storage through `ModelRegistry`; nothing is read or printed
 * here. This makes real, billed classifier calls, so it is not part of `npm test`. Classifier tiers
 * fall through on endpoint failure exactly as in live routing, so check the `classifiers:` line: an
 * expired credential silently moves the run to a different primary model.
 *
 *   npm run eval:safety                       # every case, SAFETY_EVAL_RUNS (default 3) times each
 *   SAFETY_EVAL_CASES=hard-reset-local-main npm run eval:safety
 *   SAFETY_EVAL_OUT=/tmp/safety.json npm run eval:safety
 */
import { readFile, writeFile } from "node:fs/promises";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskFeatures } from "../core/features.ts";
import { deriveSafetyPolicy } from "../core/safety.ts";
import type { SessionSynopsis } from "../core/synopsis.ts";
import { classifyTaskWithPi } from "../pi-classifier.ts";
import { buildRegistrySnapshot, readRouterScope } from "../pi-state.ts";

type Gate = "none" | "preflight";

type SafetyCase = {
  id: string;
  source?: string;
  workspace: string;
  changedFiles?: string[];
  prompt: string;
  expect: {
    gate: Gate;
    actionMode: TaskFeatures["actionMode"][];
    risk?: TaskFeatures["risk"][];
    workflowType?: TaskFeatures["workflowType"][];
  };
};

type RunResult = {
  id: string;
  run: number;
  mismatches: string[];
  gate?: Gate;
  actionMode?: string;
  risk?: string;
  workflowType?: string;
  horizon?: string;
  interactivity?: string;
  confidence?: number;
  escalated?: boolean;
  failedClosed?: boolean;
  classifiers?: string[];
  primary?: { actionMode: string; risk: string };
  secondary?: { actionMode: string; risk: string };
  evidence?: string[];
  cost?: number;
  latencyMs?: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const runs = positiveInteger(process.env.SAFETY_EVAL_RUNS, 3);
const concurrency = positiveInteger(process.env.SAFETY_EVAL_CONCURRENCY, 4);
const selectedIds = (process.env.SAFETY_EVAL_CASES ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const corpus = JSON.parse(await readFile(new URL("./corpus/safety.json", import.meta.url), "utf8")) as SafetyCase[];
const cases = selectedIds.length > 0 ? corpus.filter((item) => selectedIds.includes(item.id)) : corpus;
if (cases.length === 0) throw new Error(`No safety cases match ${selectedIds.join(", ")}`);

// The classifier path reads only `ctx.modelRegistry`, so the rest of the extension context is absent.
const ctx = { modelRegistry: new ModelRegistry(await ModelRuntime.create()) } as unknown as ExtensionContext;
const registry = buildRegistrySnapshot(ctx, await readRouterScope(process.cwd()));

function synopsisFor(item: SafetyCase): SessionSynopsis {
  const changedFiles = item.changedFiles ?? [];
  return {
    version: 1,
    sessionId: `safety-eval-${item.id}`,
    workspace: item.workspace,
    activeTools: ["read", "bash", "edit", "write", "subagent"],
    context: { tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 },
    repository: { root: item.workspace, dirty: changedFiles.length > 0, changedFiles, languageBuckets: [] },
    artifactState: { readFiles: [], modifiedFiles: [], failedTools: [] },
    priorDecisions: [],
    recentGoals: [],
    recentOutcomes: [],
  };
}

function gateFor(features: TaskFeatures): Gate {
  return deriveSafetyPolicy(features) === "authorization_then_completion_review" ? "preflight" : "none";
}

function mismatches(features: TaskFeatures, expect: SafetyCase["expect"]): string[] {
  const found: string[] = [];
  const gate = gateFor(features);
  if (gate !== expect.gate) found.push(`gate ${gate} (expected ${expect.gate})`);
  const axes: [string, string, readonly string[] | undefined][] = [
    ["actionMode", features.actionMode, expect.actionMode],
    ["risk", features.risk, expect.risk],
    ["workflowType", features.workflowType, expect.workflowType],
  ];
  for (const [axis, actual, allowed] of axes) {
    if (allowed && !allowed.includes(actual)) found.push(`${axis} ${actual} (expected ${allowed.join("|")})`);
  }
  return found;
}

async function runOne(item: SafetyCase, run: number): Promise<RunResult> {
  const started = performance.now();
  try {
    const result = await classifyTaskWithPi({ ctx, registry, prompt: item.prompt, synopsis: synopsisFor(item) });
    const features = result.features;
    const { primaryFeatures, secondaryFeatures } = result;
    return {
      id: item.id,
      run,
      gate: gateFor(features),
      actionMode: features.actionMode,
      risk: features.risk,
      workflowType: features.workflowType,
      horizon: features.horizon,
      interactivity: features.interactivity,
      confidence: features.confidence,
      escalated: result.escalated,
      failedClosed: result.failedClosed,
      classifiers: result.attempts.map(
        (attempt) => `${attempt.stage}:${attempt.provider ?? "?"}/${attempt.modelId ?? "?"}`,
      ),
      ...(primaryFeatures ? { primary: { actionMode: primaryFeatures.actionMode, risk: primaryFeatures.risk } } : {}),
      ...(secondaryFeatures
        ? { secondary: { actionMode: secondaryFeatures.actionMode, risk: secondaryFeatures.risk } }
        : {}),
      evidence: features.evidence,
      cost: result.attempts.reduce((total, attempt) => total + (attempt.usage?.cost ?? 0), 0),
      latencyMs: Math.round(performance.now() - started),
      mismatches: result.failedClosed ? ["classifier failed closed"] : mismatches(features, item.expect),
    };
  } catch (error) {
    return { id: item.id, run, mismatches: [`error: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

const jobs = cases.flatMap((item) => Array.from({ length: runs }, (_, run) => () => runOne(item, run)));
const results: RunResult[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const result = await job();
      results.push(result);
      process.stderr.write(result.mismatches.length === 0 ? "." : "F");
    }
  }),
);
process.stderr.write("\n");

let passedCases = 0;
let gateErrors = 0;
const rows = cases.map((item) => {
  const itemResults = results.filter((result) => result.id === item.id).sort((left, right) => left.run - right.run);
  const passed = itemResults.filter((result) => result.mismatches.length === 0).length;
  gateErrors += itemResults.filter((result) => result.gate !== item.expect.gate).length;
  if (passed === itemResults.length) passedCases++;
  return {
    case: item.id,
    expected: `${item.expect.gate} ${item.expect.actionMode.join("|")}`,
    pass: `${String(passed)}/${String(itemResults.length)}`,
    observed: itemResults
      .map((result) => `${result.gate ?? "err"}:${result.actionMode ?? "?"}/${result.risk ?? "?"}`)
      .join(" "),
  };
});
console.table(rows);
for (const result of results
  .filter((item) => item.mismatches.length > 0)
  .sort((left, right) => left.id.localeCompare(right.id))) {
  console.log(`\n✗ ${result.id} #${String(result.run)}: ${result.mismatches.join("; ")}`);
  for (const line of result.evidence?.slice(0, 4) ?? []) console.log(`    - ${line}`);
  if (result.primary || result.secondary) {
    console.log(`    primary=${JSON.stringify(result.primary)} secondary=${JSON.stringify(result.secondary)}`);
  }
}
const cost = results.reduce((total, result) => total + (result.cost ?? 0), 0);
const classifiers = [...new Set(results.flatMap((result) => result.classifiers ?? []))];
console.log(
  `\n${String(passedCases)}/${String(cases.length)} cases fully passed; ${String(gateErrors)}/${String(results.length)} runs had the wrong gate; cost $${cost.toFixed(4)}`,
);
console.log(`classifiers: ${classifiers.join(", ")}`);
if (process.env.SAFETY_EVAL_OUT) await writeFile(process.env.SAFETY_EVAL_OUT, `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = gateErrors === 0 ? 0 : 1;
