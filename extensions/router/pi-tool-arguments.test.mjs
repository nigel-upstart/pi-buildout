// Pi tool-argument validation and coercion contract. Pi validates every model tool call with the public
// `validateToolArguments` before an extension sees it: Pi 1.5.0 compiles the tool's JSON Schema with
// `@earendil-works/pi-schema` (coercing, on a structured clone); Pi 1.2.0-1.4.x ran TypeBox `Value.Convert` on
// TypeBox-authored schemas and a narrower primitive coercion on plain JSON Schema. The router's local TypeBox
// validators then check the normalized value semantically. These tests pin the outcomes the router relies on
// (accept/reject and the normalized value), never host error wording, and run offline under ordinary
// `npm test` and the scheduled floor/latest Pi contract canary (scripts/pi-contract-canary.mjs).
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getApiProvider,
  registerFauxProvider,
  validateToolArguments,
} from "@earendil-works/pi-ai/compat";
import { VERSION } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../subagents/index.ts";
import { conservativeFeatures, TaskFeaturesSchema, validateTaskFeatures } from "./core/features.ts";
import { ProgramPlanSchema, validateProgramPlan } from "./core/planning.ts";
import { ActionPlanSchema, validateActionPlan } from "./core/safety.ts";
import { parentSession, sdkFixture, streamMessage } from "./fixtures/pi-sdk.mjs";
import routerExtension from "./index.ts";
import { classifyTaskWithPi } from "./pi-classifier.ts";
import { inProcessReviewRunner } from "./review-runner.ts";

const [major, minor] = VERSION.split(".").map(Number);
/**
 * Documented semantic difference: before Pi 1.5.0 a plain (non-TypeBox) JSON Schema got only primitive coercion,
 * so the structural normalizations below (singleton to array, fractional integer truncation, null to `"null"`)
 * applied to TypeBox-authored schemas only. From 1.5.0 both are one JSON Schema and normalize identically.
 */
const PI_SCHEMA_HOST = major > 1 || minor >= 5;

const base = { ...conservativeFeatures("fixture"), confidence: 0.95, risk: "low" };
/** The same classifier schema as a plain JSON Schema object, as an MCP server or hand-written tool would send it. */
const plainTaskFeaturesSchema = JSON.parse(JSON.stringify(TaskFeaturesSchema));
const SCHEMAS = [
  ["TypeBox-authored", TaskFeaturesSchema],
  ["plain JSON Schema", plainTaskFeaturesSchema],
];

/** Host normalizations the classifier path accepts. `structural` ones reach plain JSON Schema only on Pi >= 1.5. */
const NORMALIZED = [
  {
    name: "numeric strings become numbers, including nested integers",
    args: {
      ...base,
      confidence: "0.95",
      expectedAgentTurns: "3",
      cacheValue: { cachedTokens: "10", expectedReuseRatio: "0.5" },
    },
    expected: { ...base, expectedAgentTurns: 3, cacheValue: { cachedTokens: 10, expectedReuseRatio: 0.5 } },
  },
  {
    name: "boolean strings become booleans",
    args: { ...base, reviewIntent: "true", decompositionRecommended: "false" },
    expected: { ...base, reviewIntent: true, decompositionRecommended: false },
  },
  {
    name: "a number becomes a string array item",
    args: { ...base, evidence: [5] },
    expected: { ...base, evidence: ["5"] },
  },
  {
    name: "a single value becomes a one-item array",
    args: { ...base, evidence: "one reason" },
    expected: { ...base, evidence: ["one reason"] },
    structural: true,
  },
  {
    // Lossy, but the host's documented conversion; the semantic range checks still run on the result.
    name: "a fractional integer truncates",
    args: { ...base, expectedAgentTurns: 2.5 },
    expected: { ...base, expectedAgentTurns: 2 },
    structural: true,
  },
  {
    name: "null in a required string array becomes the string null",
    args: { ...base, evidence: null },
    expected: { ...base, evidence: ["null"] },
    structural: true,
  },
];

/** Inputs every supported Pi rejects for both schema forms: enums, ranges, closed objects, required fields. */
const REJECTED = {
  "an out-of-enum value": { ...base, risk: "extreme" },
  "a value above its maximum": { ...base, confidence: 2 },
  "a numeric string above its maximum": { ...base, confidence: "2" },
  "a non-numeric string for a number": { ...base, confidence: "high" },
  "an integer below its minimum": { ...base, expectedAgentTurns: 0 },
  "too few array items": { ...base, evidence: [] },
  "an undeclared top-level property": { ...base, routeTo: "gpt-6-sol" },
  "an undeclared nested property": { ...base, cacheValue: { ...base.cacheValue, extra: 1 } },
  "a missing required property": Object.fromEntries(Object.entries(base).filter(([key]) => key !== "risk")),
  "null for a required enum": { ...base, risk: null },
};

function toolCall(name, args) {
  return { type: "toolCall", id: "call-1", name, arguments: args };
}

/** Run the public validator and assert it never modified the original tool-call arguments. */
function validate(parameters, args, { rejects = false } = {}) {
  const original = structuredClone(args);
  try {
    const run = () =>
      validateToolArguments({ name: "report_task_features", description: "", parameters }, toolCall("t", args));
    // Only the host call is inside assert.throws; an immutability failure must fail the test itself.
    if (rejects) {
      assert.throws(run, Error);
      return;
    }
    return run();
  } finally {
    assert.deepEqual(args, original, "the original tool-call arguments are unchanged");
  }
}

describe(`Pi ${VERSION} public tool-argument validator with the classifier schema`, () => {
  for (const [form, schema] of SCHEMAS) {
    for (const { name, args, expected, structural } of NORMALIZED) {
      const normalizes = !structural || form === "TypeBox-authored" || PI_SCHEMA_HOST;
      it(`${form}: ${name}${normalizes ? "" : " (rejected before Pi 1.5)"}`, () => {
        if (!normalizes) {
          validate(schema, args, { rejects: true });
          return;
        }
        const value = validate(schema, args);
        assert.deepEqual(value, expected);
        // The normalized value, not the raw arguments, is what the local semantic validator consumes.
        const local = validateTaskFeatures(value);
        assert.equal(local.success, true, JSON.stringify(local.errors));
        assert.deepEqual(local.value, expected);
      });
    }
    for (const [name, args] of Object.entries(REJECTED))
      it(`${form}: rejects ${name}`, () => {
        validate(schema, args, { rejects: true });
      });
  }

  it("normalizes TypeBox-authored and plain JSON Schema identically from Pi 1.5", { skip: !PI_SCHEMA_HOST }, () => {
    for (const { args } of NORMALIZED)
      assert.deepEqual(validate(TaskFeaturesSchema, args), validate(plainTaskFeaturesSchema, args));
  });

  it("leaves already valid arguments unchanged", () => {
    assert.deepEqual(validate(TaskFeaturesSchema, base), base);
  });
});

/** A classifier invocation against one faux provider endpoint, returning every response in order. */
async function classify(t, responses, delivered = []) {
  const faux = registerFauxProvider({
    api: `router-tool-arguments-${String(Math.random()).slice(2)}`,
    provider: "router-tool-arguments",
    models: [{ id: "classifier-fixture" }],
  });
  t.after(() => faux.unregister());
  // Observe the response returned to complete(), after the faux provider's own cloning.
  const provider = getApiProvider(faux.api);
  const stream = provider.stream;
  t.mock.method(provider, "stream", (...args) => {
    const response = stream(...args);
    const result = response.result.bind(response);
    t.mock.method(response, "result", async () => {
      const message = await result();
      delivered.push(...message.content.filter((content) => content.type === "toolCall"));
      return message;
    });
    return response;
  });
  faux.setResponses(responses.map((args) => fauxAssistantMessage([fauxToolCall("report_task_features", args)])));
  return classifyTaskWithPi({
    ctx: {
      modelRegistry: { find: () => faux.getModel(), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
    },
    registry: [
      {
        provider: "openai-codex",
        modelId: "gpt-6-luna",
        name: "gpt-6-luna",
        vendor: "openai",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        available: true,
        reasoning: true,
        supportedEfforts: ["low"],
        inputTypes: ["text"],
        toolCapable: true,
        costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ],
    prompt: "Implement the change",
    synopsis: {},
  });
}

describe(`Pi ${VERSION} router classifier path`, () => {
  it("consumes the host-normalized features and leaves the model's tool-call arguments unchanged", async (t) => {
    const args = { ...base, confidence: "0.95", expectedFilesRead: "12", evidence: "Touches one module" };
    const original = structuredClone(args);
    const delivered = [];
    const result = await classify(t, [args], delivered);
    assert.equal(result.failedClosed, false);
    assert.equal(result.attempts[0]?.valid, true);
    assert.deepEqual(result.features, { ...base, expectedFilesRead: 12, evidence: ["Touches one module"] });
    assert.equal(delivered.length, 1);
    assert.notEqual(delivered[0].arguments, args, "the provider cloned the fixture");
    assert.deepEqual(delivered[0].arguments, original, "the classifier leaves its received arguments unchanged");
  });

  it("fails closed on host-rejected arguments without persisting the raw validator error", async (t) => {
    const secret = "RAW-ARGUMENT-SENTINEL-41";
    const invalid = { ...base, risk: "extreme", evidence: [secret] };
    const f = await sdkFixture(t);
    const environment = {
      PI_ROUTER_MODE: "shadow",
      PI_ROUTER_MODEL_SCOPE: "*",
      PI_ROUTER_ENDPOINT_HEALTH_PATH: join(f.cwd, "no-health.json"),
      PI_ROUTER_LAST_MODE_PATH: join(f.cwd, "last-mode.jsonl"),
    };
    for (const [key, value] of Object.entries(environment)) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const events = [];
    let result;
    const session = await parentSession(t, f, [
      (pi) =>
        routerExtension(pi, {
          telemetry: {
            append: async (event) => events.push(structuredClone(event)),
            read: async () => [],
          },
          classifyTask: async () => {
            result = await classify(t, [invalid, invalid]);
            return result;
          },
        }),
    ]);
    f.respond = (model) => streamMessage(model, []);
    await session.prompt("Implement the change");
    assert.equal(result.failedClosed, true);
    assert.deepEqual(result.features, conservativeFeatures("Primary classifier failed schema validation"));
    assert.equal(result.attempts.length, 2);
    assert.ok(result.attempts.every((attempt) => attempt.valid === false));
    for (const attempt of result.attempts)
      assert.ok(
        attempt.errors.some((error) => error.includes(secret)),
        "the raw host error contains the sentinel",
      );
    const attempts = events.filter(({ kind }) => kind === "classifier_attempt");
    const decisions = events.filter(({ kind }) => kind === "route_decision");
    assert.equal(attempts.length, 2, "the router emitted both rejected attempts");
    assert.equal(decisions.length, 1, "the router emitted a route decision");
    for (const attempt of [...attempts.map(({ data }) => data), ...decisions[0].data.classifierAttempts]) {
      assert.ok(attempt.errorCount > 0);
      assert.deepEqual(attempt.errors, []);
    }
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret), "emitted telemetry never carries raw arguments");
  });
});

const actionPlan = {
  objective: "Rotate the fixture key",
  targets: ["config/key.json"],
  assumptions: [],
  preconditions: ["Backup exists"],
  steps: [
    {
      id: "s1",
      action: "Rewrite the key",
      target: "config/key.json",
      expectedEffect: "New key",
      potentiallyIrreversible: false,
    },
  ],
  verification: ["Read it back"],
  rollback: ["Restore the backup"],
  abortConditions: ["Backup missing"],
  toolNames: ["edit"],
};
const programPlan = {
  objective: "Ship the feature",
  assumptions: [],
  unknowns: [],
  pullRequests: [
    {
      id: "pr-1",
      title: "First",
      goal: "Add it",
      dependsOn: [],
      acceptanceCriteria: ["Tests pass"],
      rollout: "Merge",
      rollback: "Revert",
      risks: [],
      unknowns: [],
    },
  ],
};

/** Wrap an extension so each registered tool records the params Pi hands to `execute`. */
function recordingParams(factory, seen) {
  return (pi) =>
    factory(
      new Proxy(pi, {
        get(target, property) {
          if (property === "registerTool")
            return (tool) =>
              target.registerTool({
                ...tool,
                execute: (id, params, ...rest) => {
                  seen.push({ tool: tool.name, params: structuredClone(params) });
                  return tool.execute(id, params, ...rest);
                },
              });
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
}

test(`Pi ${VERSION} hands planning and subagent tools normalized arguments and keeps the transcript original`, async (t) => {
  const f = await sdkFixture(t);
  const seen = [];
  const local = [];
  const session = await parentSession(t, f, [
    recordingParams((pi) => {
      // The router's planning tools validate locally with these exact schemas and validators.
      pi.registerTool({
        name: "submit_action_plan",
        label: "Action plan",
        description: "Fixture with the router's action-plan schema",
        parameters: ActionPlanSchema,
        execute: async (_id, params) => {
          local.push(["submit_action_plan", validateActionPlan(params).success]);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
      pi.registerTool({
        name: "submit_implementation_plan",
        label: "Implementation plan",
        description: "Fixture with the router's program-plan schema",
        parameters: ProgramPlanSchema,
        execute: async (_id, params) => {
          local.push(["submit_implementation_plan", validateProgramPlan(params).success]);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    }, seen),
    // The real subagent extension; `list` and rejected calls spawn no child process.
    recordingParams(subagentsExtension, seen),
  ]);
  const calls = [
    {
      id: "plan",
      name: "submit_action_plan",
      arguments: {
        ...actionPlan,
        targets: "config/key.json",
        steps: [{ ...actionPlan.steps[0], potentiallyIrreversible: "false" }],
      },
    },
    {
      id: "program",
      name: "submit_implementation_plan",
      arguments: {
        ...programPlan,
        pullRequests: [{ ...programPlan.pullRequests[0], acceptanceCriteria: "Tests pass" }],
      },
    },
    { id: "subagent", name: "subagent", arguments: { action: "list", timeoutMs: "5000" } },
    { id: "bad-plan", name: "submit_action_plan", arguments: { ...actionPlan, grantsPermission: true } },
    { id: "bad-subagent", name: "subagent", arguments: { action: "spawn_unbounded" } },
  ];
  const original = structuredClone(calls);
  let turn = 0;
  f.respond = (model) =>
    turn++ === 0
      ? streamMessage(
          model,
          calls.map((call) => ({ type: "toolCall", ...call })),
          "toolUse",
        )
      : streamMessage(model, []);
  await session.prompt("Submit the plans");

  assert.deepEqual(seen, [
    { tool: "submit_action_plan", params: actionPlan },
    { tool: "submit_implementation_plan", params: programPlan },
    { tool: "subagent", params: { action: "list", timeoutMs: 5000 } },
  ]);
  assert.deepEqual(local, [
    ["submit_action_plan", true],
    ["submit_implementation_plan", true],
  ]);
  const results = new Map(
    session.messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]),
  );
  for (const id of ["plan", "program", "subagent"]) assert.equal(results.get(id)?.isError, false, id);
  // Host-rejected calls never reach `execute`, and surface as error results instead of crashing the run.
  for (const id of ["bad-plan", "bad-subagent"]) assert.equal(results.get(id)?.isError, true, id);
  const transcript = session.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((content) => content.type === "toolCall")
    .map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
  assert.deepEqual(transcript, original, "the transcript keeps the model's original arguments");
  assert.deepEqual(calls, original);
});

test(`Pi ${VERSION} reviewer session records the host-normalized verdict`, async (t) => {
  const f = await sdkFixture(t);
  const scope = "d".repeat(64);
  const verdict = {
    reviewKind: "plan",
    scopeFingerprint: scope,
    verdict: "approve",
    summary: "Bounded",
    evidence: "Inspected plan",
    findings: [],
  };
  let calls = 0;
  f.respond = (model) =>
    calls++ === 0
      ? streamMessage(
          model,
          [{ type: "toolCall", id: "v", name: "submit_safety_review", arguments: verdict }],
          "toolUse",
        )
      : streamMessage(model, []);
  const result = await inProcessReviewRunner.start({
    cwd: f.cwd,
    registry: f.registry,
    model: f.model,
    effort: "off",
    kind: "plan",
    scopeFingerprint: scope,
    systemPrompt: "REVIEW_ONLY_SYSTEM",
    prompt: "Review",
    timeoutMs: 5000,
    maxCost: 1,
  }).result;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verdict, { ...verdict, evidence: ["Inspected plan"] });
  assert.equal(verdict.evidence, "Inspected plan");
});
