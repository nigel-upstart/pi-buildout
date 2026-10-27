import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { fastCheckOptions } from "../fast-check-options.mjs";
import {
  consumeDiscoveryGrant,
  discoveryApprovalFingerprint,
  discoveryScopeFingerprint,
  safetyFingerprint,
  validateDiscoveryRequest,
} from "./safety.ts";

const jsonInput = fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue({ maxDepth: 5 }), { maxKeys: 8 });
const request = (input) => ({
  purpose: "discovery",
  objective: "Identify owner",
  target: "inventory",
  expectedEffects: ["Return metadata"],
  preconditions: ["Bounded query"],
  verification: ["Compare IDs"],
  abortConditions: ["Unexpected effects"],
  toolName: "bash",
  input,
});

function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reorder(child)]),
    );
  }
  return value;
}

describe("generated discovery invariants", () => {
  it("accepts JSON and preserves exact fingerprints under recursive key reordering", () => {
    fc.assert(
      fc.property(jsonInput, (input) => {
        const validated = validateDiscoveryRequest(request(input));
        assert.equal(validated.success, true);
        assert.equal(validateDiscoveryRequest(reorder(request(input))).fingerprint, validated.fingerprint);
      }),
      fastCheckOptions,
    );
  });

  it("rejects non-JSON values at generated nesting depths", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, Symbol("unsafe"), () => {}),
        fc.boolean(),
        (depth, invalid, array) => {
          let value = invalid;
          for (let index = 0; index < depth; index++) value = array ? [value] : { nested: value };
          assert.equal(validateDiscoveryRequest(request({ value })).success, false);
        },
      ),
      fastCheckOptions,
    );
  });

  it("spends only identical input and never permits replay", () => {
    fc.assert(
      fc.property(jsonInput, (input) => {
        const context = { taskFingerprint: "task", cwd: "/repo", sessionId: "session" };
        const validated = validateDiscoveryRequest(request(input));
        assert.equal(validated.success, true);
        const scopeFingerprint = discoveryScopeFingerprint(validated.request, "task", "/repo", "session");
        const ready = {
          phase: "discovery_ready",
          policy: "authorization_then_completion_review",
          taskFingerprint: "task",
          grant: {
            ...context,
            request: validated.request,
            requestFingerprint: validated.fingerprint,
            scopeFingerprint,
            reviewTaskId: "review",
            reviewerVendor: "anthropic",
            approvedAt: "2026-10-07",
            approvalFingerprint: discoveryApprovalFingerprint(scopeFingerprint, "review", "anthropic", "2026-10-07"),
          },
        };
        const changed = { ...input, extraUnreviewedArgument: safetyFingerprint(input) };
        assert.equal(consumeDiscoveryGrant(ready, "bash", changed, context).allowed, false);
        const spent = consumeDiscoveryGrant(ready, "bash", reorder(input), context);
        assert.equal(spent.allowed, true);
        assert.equal(consumeDiscoveryGrant(spent.lifecycle, "bash", input, context).allowed, false);
      }),
      fastCheckOptions,
    );
  });
});
