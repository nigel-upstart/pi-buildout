import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  consumeDiscoveryGrant,
  deriveSafetyPolicy,
  discoveryApprovalFingerprint,
  discoveryScopeFingerprint,
  initialLifecycle,
  isLeaseLifecycle,
  isPotentiallyMutatingTool,
  lifecycleToolBlockReason,
  safetyContextForLifecycle,
  safetyFingerprint,
  validateActionPlan,
  validateDiscoveryRequest,
  validateSafetyReview,
} from "./safety.ts";

function actionPlan() {
  return {
    objective: "Rotate the production signing key without losing access.",
    targets: ["production/keyring"],
    assumptions: ["The old key remains valid during the overlap."],
    preconditions: ["A tested break-glass credential is available."],
    steps: [
      {
        id: "rotate",
        action: "Create and activate the replacement key, then revoke the old key.",
        target: "production/keyring",
        expectedEffect: "New signatures use the replacement key and the old credential stops working.",
        potentiallyIrreversible: true,
      },
    ],
    verification: ["Verify new signatures from two independent clients."],
    rollback: ["Reactivate the old key during the overlap window."],
    abortConditions: ["Stop if break-glass authentication fails."],
    authorizedToolNames: ["bash"],
  };
}

describe("router safety policy", () => {
  it("distinguishes authorization, advisory, completion review, and ordinary review", () => {
    const base = conservativeFeatures("policy test");
    assert.equal(
      deriveSafetyPolicy({ ...base, risk: "critical", actionMode: "destructive", intent: "operate" }),
      "authorization_then_completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "high",
        actionMode: "reversible_mutation",
        intent: "operate",
        workflowType: "incident_or_operations",
      }),
      "advisory_then_completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "high",
        actionMode: "reversible_mutation",
        intent: "implement",
        workflowType: "coding_implementation",
      }),
      "completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "critical",
        actionMode: "external_side_effect",
        intent: "review",
        workflowType: "code_review",
      }),
      "ordinary",
      "standalone review is orthogonal to tracked-work safety lifecycles",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "medium",
        actionMode: "external_side_effect",
        intent: "operate",
        interactivity: "autonomous",
        horizon: "program_unknown_size",
      }),
      "authorization_then_completion_review",
      "an indefinite unattended external-effect loop is broad-impact even if the classifier understates risk",
    );
    assert.equal(
      deriveSafetyPolicy({ ...base, risk: "high", actionMode: "local_read", intent: "research" }),
      "ordinary",
    );
  });
});

describe("irreversible action plans", () => {
  it("validates concrete irreversible effects and fingerprints plans canonically", () => {
    const result = validateActionPlan(actionPlan());
    assert.equal(result.success, true, result.success ? "" : result.errors.join("\n"));
    assert.equal(result.fingerprint, safetyFingerprint(actionPlan()));
    assert.equal(result.fingerprint.length, 64);

    // Property insertion order must not change the fingerprint, so build the same plan with the
    // objective inserted last rather than first.
    const { objective, ...rest } = actionPlan();
    const reordered = { ...rest, objective };
    assert.notDeepEqual(Object.keys(reordered), Object.keys(actionPlan()), "the fixture must reorder properties");
    assert.equal(safetyFingerprint(reordered), result.fingerprint);
  });

  it("rejects vague plans that do not identify an irreversible step", () => {
    const invalid = actionPlan();
    invalid.steps[0].potentiallyIrreversible = false;
    assert.match(validateActionPlan(invalid).errors.join("\n"), /potentially irreversible effect/);
  });

  it("rejects steps that act outside the declared targets", () => {
    const invalid = actionPlan();
    invalid.steps[0].target = "staging/keyring";
    assert.match(validateActionPlan(invalid).errors.join("\n"), /undeclared target: staging\/keyring/);
  });
});

describe("canonical fingerprints", () => {
  it("orders object keys by UTF-16 code unit, independent of locale and insertion order", () => {
    // Canonically equivalent but distinct keys: localeCompare treats them as equal, so a stable sort kept
    // insertion order and reordering the object changed the fingerprint.
    const precomposedFirst = { "\u00e9": 1, "e\u0301": 2 };
    const decomposedFirst = { "e\u0301": 2, "\u00e9": 1 };
    assert.equal(safetyFingerprint(precomposedFirst), safetyFingerprint(decomposedFirst));
    // Code-unit order puts "B" (U+0042) before "a" (U+0061); a locale collation would not.
    assert.equal(safetyFingerprint({ a: 1, B: 2 }), createHash("sha256").update('{"B":2,"a":1}').digest("hex"));
  });
});

describe("single-call discovery grants", () => {
  const context = { taskFingerprint: "task", cwd: "/repo", sessionId: "session" };
  const request = () => ({
    purpose: "discovery",
    objective: "Inspect available incidents before proposing an irreversible action.",
    target: "Glean incident search",
    expectedEffects: ["Return matching incident metadata; no content changes expected"],
    preconditions: ["Authenticated Glean access"],
    verification: ["Review returned incident IDs"],
    abortConditions: ["Unexpected write or broader search scope"],
    toolName: "bash",
    input: { command: "glean search 'key rotation'  " },
  });
  function ready() {
    const validated = validateDiscoveryRequest(request());
    assert.equal(validated.success, true);
    const scopeFingerprint = discoveryScopeFingerprint(
      validated.request,
      context.taskFingerprint,
      context.cwd,
      context.sessionId,
    );
    return {
      phase: "discovery_ready",
      policy: "authorization_then_completion_review",
      taskFingerprint: context.taskFingerprint,
      grant: {
        request: validated.request,
        requestFingerprint: validated.fingerprint,
        scopeFingerprint,
        approvalFingerprint: discoveryApprovalFingerprint(
          scopeFingerprint,
          "independent-review",
          "anthropic",
          "2026-07-28T00:00:00.000Z",
        ),
        ...context,
        reviewTaskId: "independent-review",
        reviewerVendor: "anthropic",
        approvedAt: "2026-07-28T00:00:00.000Z",
      },
    };
  }

  it("accepts only the narrow discovery schema and finite JSON object inputs", () => {
    assert.equal(validateDiscoveryRequest(request()).success, true);
    const nested = { ...request(), input: { command: "literal  ", options: [null, 1, { enabled: true }] } };
    const reordered = { ...request(), input: { options: [null, 1, { enabled: true }], command: "literal  " } };
    const nestedValidation = validateDiscoveryRequest(nested);
    const reorderedValidation = validateDiscoveryRequest(reordered);
    assert.equal(nestedValidation.success, true);
    assert.equal(reorderedValidation.success, true);
    assert.equal(nestedValidation.fingerprint, reorderedValidation.fingerprint);
    for (const invalid of [
      { ...request(), purpose: "execution" },
      { ...request(), extra: "not in schema" },
      { ...request(), input: ["command"] },
      { ...request(), input: { command: undefined } },
      { ...request(), input: { command: NaN } },
      { ...request(), input: { command: Infinity } },
      { ...request(), input: { command: -0 } },
      { ...request(), input: { command: 1n } },
      { ...request(), input: { command: new Date() } },
      { ...request(), input: { nested: { accessor: () => "not JSON" } } },
      { ...request(), input: { values: Array(1) } },
    ]) {
      assert.equal(validateDiscoveryRequest(invalid).success, false, `accepted ${String(invalid.input)}`);
    }
    const cyclic = { command: "test" };
    cyclic.self = cyclic;
    assert.equal(validateDiscoveryRequest({ ...request(), input: cyclic }).success, false);
    const accessor = Object.defineProperty({}, "command", { enumerable: true, get: () => "unexpected" });
    assert.equal(validateDiscoveryRequest({ ...request(), input: accessor }).success, false);
    const topLevelAccessor = Object.defineProperty(request(), "objective", {
      enumerable: true,
      get: () => "unexpected",
    });
    assert.equal(validateDiscoveryRequest(topLevelAccessor).success, false);
    const hidden = Object.defineProperty({ command: "search" }, "extra", { value: "hidden" });
    assert.equal(validateDiscoveryRequest({ ...request(), input: hidden }).success, false);
    const arraySubclass = Object.setPrototypeOf(["valid-looking"], Object.create(Array.prototype));
    assert.equal(validateDiscoveryRequest({ ...request(), input: { args: arraySubclass } }).success, false);
    let proxyReads = 0;
    const shifting = new Proxy(
      { command: "ls" },
      { get: (target, key) => (key === "command" ? (proxyReads++ ? "rm -rf x" : "ls") : Reflect.get(target, key)) },
    );
    assert.equal(validateDiscoveryRequest({ ...request(), input: shifting }).success, false, "proxies are rejected");
    assert.equal(validateDiscoveryRequest({ ...request(), input: { args: new Proxy([], {}) } }).success, false);
    const bogusIndex = Array(1);
    Object.defineProperty(bogusIndex, "4294967295", { value: 1, enumerable: true });
    assert.equal(
      validateDiscoveryRequest({ ...request(), input: { args: bogusIndex } }).success,
      false,
      "array keys must be exactly 0..length-1",
    );
    const revoked = Proxy.revocable({ command: "search" }, {});
    revoked.revoke();
    assert.equal(validateDiscoveryRequest({ ...request(), input: revoked.proxy }).success, false);
  });

  it("accepts requests up to 64 KiB of serialized JSON without changing exact inputs", () => {
    const empty = { ...request(), input: { command: "" } };
    const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
    for (const bytes of [65_535, 65_536, 65_537]) {
      const candidate = { ...empty, input: { command: "x".repeat(bytes - overhead - 2) + "  " } };
      assert.equal(Buffer.byteLength(JSON.stringify(candidate), "utf8"), bytes);
      const validated = validateDiscoveryRequest(candidate);
      assert.equal(validated.success, bytes <= 65_536);
      if (validated.success) {
        assert.deepEqual(validated.request, candidate);
        assert.equal(validated.request.input, candidate.input);
        assert.equal(validated.fingerprint, safetyFingerprint(candidate));
      } else {
        assert.match(validated.errors.join("\n"), /64 KiB \(65536 bytes\)/);
        assert.equal("request" in validated, false);
        assert.equal("fingerprint" in validated, false);
      }
    }
  });

  it("counts UTF-8 bytes and JSON escaping at the size boundary", () => {
    const empty = { ...request(), input: { command: "" } };
    const available = 65_536 - Buffer.byteLength(JSON.stringify(empty), "utf8");
    for (const character of ["é", "😀", '"', "\u0000", "\ud800"]) {
      const bytesPerCharacter = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
      const command =
        character.repeat(Math.floor(available / bytesPerCharacter)) + " ".repeat(available % bytesPerCharacter);
      const candidate = { ...empty, input: { command } };
      assert.equal(Buffer.byteLength(JSON.stringify(candidate), "utf8"), 65_536);
      const validated = validateDiscoveryRequest(candidate);
      assert.equal(validated.success, true);
      assert.equal(validated.request.input.command, command);
      const tooLarge = { ...candidate, input: { command: command + "x" } };
      assert.match(validateDiscoveryRequest(tooLarge).errors.join("\n"), /64 KiB \(65536 bytes\)/);
    }
  });

  it("counts metadata, input keys, and nested values in the aggregate limit", () => {
    const candidates = [
      { ...request(), input: { command: "x".repeat(65_536 - 20) } },
      { ...request(), input: { ["x".repeat(65_536)]: "" } },
      { ...request(), input: { parts: Array.from({ length: 128 }, () => "x".repeat(512)) } },
      {
        ...request(),
        expectedEffects: Array.from({ length: 20 }, () => "x".repeat(2_000)),
        preconditions: Array.from({ length: 20 }, () => "x".repeat(2_000)),
        input: {},
      },
    ];
    assert.ok(Buffer.byteLength(JSON.stringify(candidates[0].input), "utf8") < 65_536);
    for (const candidate of candidates) {
      assert.ok(Buffer.byteLength(JSON.stringify(candidate), "utf8") > 65_536);
      assert.match(validateDiscoveryRequest(candidate).errors.join("\n"), /64 KiB \(65536 bytes\)/);
    }
  });

  it("rejects a very large single string with a bounded error instead of truncating it", () => {
    const candidate = { ...request(), input: { command: "x".repeat(5_000_000) } };
    const validated = validateDiscoveryRequest(candidate);
    assert.equal(validated.success, false);
    assert.match(validated.errors.join("\n"), /64 KiB \(65536 bytes\)/);
    assert.ok(validated.errors.join("\n").length < 300);
    assert.equal("request" in validated, false);
    assert.equal("fingerprint" in validated, false);
    assert.equal(candidate.input.command.length, 5_000_000);
  });

  it("validates the grant binding to task, cwd, session, request and reviewer identity", () => {
    const lifecycle = ready();
    assert.equal(isLeaseLifecycle(lifecycle), true);
    for (const tampered of [
      { ...lifecycle, taskFingerprint: "other task" },
      { ...lifecycle, grant: { ...lifecycle.grant, cwd: "/other" } },
      { ...lifecycle, grant: { ...lifecycle.grant, sessionId: "other session" } },
      { ...lifecycle, grant: { ...lifecycle.grant, reviewerVendor: "" } },
      { ...lifecycle, grant: { ...lifecycle.grant, reviewerVendor: "other reviewer" } },
      { ...lifecycle, grant: { ...lifecycle.grant, reviewTaskId: "" } },
      { ...lifecycle, grant: { ...lifecycle.grant, request: { ...lifecycle.grant.request, toolName: "edit" } } },
      { ...lifecycle, grant: { ...lifecycle.grant, scopeFingerprint: "a".repeat(64) } },
      { ...lifecycle, grant: { ...lifecycle.grant, unexpected: true } },
    ])
      assert.equal(isLeaseLifecycle(tampered), false);
  });

  it("consumes an exact call once without accepting same-name/different-input or changed shell text", () => {
    const lifecycle = ready();
    assert.match(safetyContextForLifecycle(lifecycle), /one exact/);
    assert.match(
      lifecycleToolBlockReason(lifecycle, "bash", lifecycle.grant.request.input),
      /exact approved discovery/,
    );
    assert.equal(lifecycleToolBlockReason(lifecycle, "read", { path: "README.md" }), undefined);
    for (const [toolName, input, caller] of [
      ["edit", lifecycle.grant.request.input, context],
      ["bash", { command: "glean search 'key rotation'" }, context],
      ["bash", { command: "glean search 'key rotation'  ", extra: true }, context],
      ["bash", lifecycle.grant.request.input, { ...context, cwd: "/other" }],
      ["bash", lifecycle.grant.request.input, { ...context, sessionId: "other" }],
      ["bash", lifecycle.grant.request.input, { ...context, taskFingerprint: "other" }],
    ]) {
      assert.equal(consumeDiscoveryGrant(lifecycle, toolName, input, caller).allowed, false);
      assert.equal(isLeaseLifecycle(lifecycle), true, "a mismatch must not mutate or consume the grant");
    }
    const allowed = consumeDiscoveryGrant(lifecycle, "bash", { command: "glean search 'key rotation'  " }, context);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.lifecycle.phase, "preflight");
    assert.equal(
      consumeDiscoveryGrant(allowed.lifecycle, "bash", lifecycle.grant.request.input, context).allowed,
      false,
    );
    assert.match(lifecycleToolBlockReason(allowed.lifecycle, "bash", lifecycle.grant.request.input), /preflight/);
  });
});

describe("deterministic safety tool gate", () => {
  it("blocks mutation in preflight and advisory while allowing bounded inspection", () => {
    const preflight = initialLifecycle("authorization_then_completion_review", "task");
    assert.equal(lifecycleToolBlockReason(preflight, "read", { path: "README.md" }), undefined);
    assert.equal(lifecycleToolBlockReason(preflight, "bash", { command: "git diff --stat" }), undefined);
    assert.match(lifecycleToolBlockReason(preflight, "edit", { path: "README.md" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "git status; rm -rf out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "git diff --output=/tmp/leak" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -delete" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprintf out %p" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprint0 out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fls out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprint out" }), /preflight/);
    assert.equal(lifecycleToolBlockReason(preflight, "bash", { command: "find . -name '*.ts'" }), undefined);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "rg --pre mutate pattern" }), /preflight/);
    assert.equal(lifecycleToolBlockReason(preflight, "submit_action_plan", {}), undefined);
    // The chained inspection refused in session 01a0ebc8 is read-only in every segment.
    assert.equal(
      lifecycleToolBlockReason(preflight, "bash", {
        command: "cd ~/repo && git status && git branch -vv | head -20; git stash list | head",
      }),
      undefined,
    );

    const validated = validateActionPlan(actionPlan());
    assert.equal(validated.success, true);
    const authorized = {
      phase: "authorized_execution",
      policy: "authorization_then_completion_review",
      taskFingerprint: "task",
      plan: {
        taskFingerprint: "task",
        planFingerprint: validated.fingerprint,
        submittedAt: "2026-07-28T00:00:00.000Z",
        plan: validated.plan,
      },
      authorization: {
        taskFingerprint: "task",
        planFingerprint: validated.fingerprint,
        reviewTaskId: "review",
        reviewerVendor: "anthropic",
        sessionId: "session",
        approvedAt: "2026-07-28T00:01:00.000Z",
      },
    };
    assert.equal(lifecycleToolBlockReason(authorized, "bash", { command: "deploy production" }), undefined);
    assert.match(lifecycleToolBlockReason(authorized, "custom_mutator", {}), /outside.*reviewed action plan/);
    assert.equal(isLeaseLifecycle(authorized), true);
    assert.equal(
      isLeaseLifecycle({
        ...authorized,
        authorization: { ...authorized.authorization, planFingerprint: "tampered" },
      }),
      false,
      "restoration must reject authorization not bound to the persisted plan",
    );

    const advisory = initialLifecycle("advisory_then_completion_review", "task");
    assert.match(lifecycleToolBlockReason(advisory, "custom_mutator", {}), /advisory/);
  });

  it("explains a refused command so the model does not conclude bash is unavailable", () => {
    const preflight = initialLifecycle("authorization_then_completion_review", "task");
    const refused = lifecycleToolBlockReason(preflight, "bash", { command: "git status && git checkout main" });
    assert.match(refused, /git checkout is not a read-only subcommand/);
    assert.match(refused, /Read-only bash still runs/);
    assert.match(refused, /call submit_action_plan/);
    const edit = lifecycleToolBlockReason(preflight, "edit", { path: "README.md" });
    assert.doesNotMatch(edit, /Read-only bash/, "non-bash refusals carry no shell detail");
    assert.match(edit, /call submit_action_plan/);
    const advisoryLifecycle = initialLifecycle("advisory_then_completion_review", "task");
    assert.match(
      lifecycleToolBlockReason(advisoryLifecycle, "bash", { command: "npm test" }),
      /npm is not a read-only command/,
    );
    assert.match(safetyContextForLifecycle(preflight), /read-only bash/);
  });

  it("keeps the read-only classifier and the mutation classifier inverses of each other", () => {
    // A command the read-only gate refuses must count as potentially mutating, so a classifier gap
    // can only ever narrow what runs, never widen what is recorded as a mutation.
    const preflight = initialLifecycle("authorization_then_completion_review", "task");
    for (const command of [
      "git diff --stat HEAD",
      "rg -n pattern src",
      "find . -name '*.ts'",
      "find . -exec rm {} +",
      "git diff --output=/tmp/leak",
      "npm test",
      "ls\nrm -rf /",
      "",
    ]) {
      const blocked = lifecycleToolBlockReason(preflight, "bash", { command }) !== undefined;
      assert.equal(
        isPotentiallyMutatingTool("bash", { command }),
        blocked,
        `${JSON.stringify(command)} must be blocked in preflight exactly when it counts as mutating`,
      );
    }
  });

  it("maps only constrained phases to a lifecycle prompt", () => {
    assert.match(
      safetyContextForLifecycle(initialLifecycle("authorization_then_completion_review", "t")),
      /preflight|non-mutating/,
    );
    assert.match(safetyContextForLifecycle(initialLifecycle("advisory_then_completion_review", "t")), /advisor/);
    assert.equal(safetyContextForLifecycle(initialLifecycle("completion_review", "t")), undefined);
    assert.equal(safetyContextForLifecycle(initialLifecycle("ordinary", "t")), undefined);
    assert.match(
      safetyContextForLifecycle({
        phase: "review",
        policy: "ordinary",
        taskFingerprint: "t",
        reviewKind: "completion",
        scopeFingerprint: "a".repeat(64),
      }),
      /read-only completion review scoped to a{64}/,
    );
  });

  it("keeps generated reviews read-only except for the scoped verdict tool", () => {
    const review = {
      phase: "review",
      policy: "ordinary",
      taskFingerprint: "task",
      reviewKind: "authorization",
      scopeFingerprint: "a".repeat(64),
    };
    assert.equal(lifecycleToolBlockReason(review, "submit_safety_review", {}), undefined);
    assert.match(lifecycleToolBlockReason(review, "write", {}), /read-only/);
  });
});

describe("review verdict validation", () => {
  it("binds the kind and verdict to the exact reviewed scope", () => {
    const scope = "a".repeat(64);
    const valid = validateSafetyReview(
      {
        reviewKind: "authorization",
        scopeFingerprint: scope,
        verdict: "approve",
        summary: "The preconditions and abort points bound the risk.",
        evidence: ["Rollback was verified against the named target."],
        findings: [],
      },
      "authorization",
      scope,
    );
    assert.equal(valid.success, true);
    assert.match(
      validateSafetyReview(
        {
          reviewKind: "authorization",
          scopeFingerprint: "b".repeat(64),
          verdict: "pass",
          summary: "Wrong scope and verdict.",
          evidence: ["Mismatch."],
          findings: [],
        },
        "authorization",
        scope,
      ).errors.join("\n"),
      /scope fingerprint|invalid for authorization/,
    );
  });
});
