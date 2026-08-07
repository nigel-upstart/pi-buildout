import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAudit } from "./check-audit.ts";

const braceNodes = ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"];

function auditReport() {
  return {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 } },
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        nodes: braceNodes,
        via: [
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
          },
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
          },
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
          },
        ],
      },
      undici: {
        name: "undici",
        severity: "high",
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"],
        via: [
          {
            severity: "high",
            url: "https://github.com/advisories/GHSA-4cwx-7wf7-3272",
          },
        ],
      },
      minimatch: {
        name: "minimatch",
        severity: "high",
        nodes: ["node_modules/minimatch"],
        via: ["brace-expansion"],
      },
      eslint: {
        name: "eslint",
        severity: "high",
        nodes: ["node_modules/eslint"],
        via: ["minimatch"],
      },
    },
  };
}

describe("evaluateAudit", () => {
  it("accepts reviewed direct advisories and findings derived only from them", () => {
    const result = evaluateAudit(auditReport());

    assert.equal(result.unexplained.length, 0);
    assert.deepEqual(result.acceptedAdvisories.map(({ advisoryUrl }) => advisoryUrl).sort(), [
      "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
      "https://github.com/advisories/GHSA-4cwx-7wf7-3272",
      "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
      "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
    ]);
  });

  it("fails closed when npm groups a new advisory with reviewed advisories", () => {
    const report = auditReport();
    report.vulnerabilities["brace-expansion"].via.push({
      severity: "critical",
      url: "https://github.com/advisories/GHSA-unreviewed",
    });

    const result = evaluateAudit(report);

    assert.deepEqual(result.unexplained.map(({ name }) => name).sort(), ["brace-expansion", "eslint", "minimatch"]);
  });

  it("fails closed when a reviewed advisory appears at a different path", () => {
    const report = auditReport();
    report.vulnerabilities["brace-expansion"].nodes.push("node_modules/new-consumer/node_modules/brace-expansion");

    assert.equal(evaluateAudit(report).unexplained.length, 3);
  });

  it("rejects unsuccessful or malformed npm audit reports", () => {
    assert.throws(() => evaluateAudit({ error: { summary: "registry unavailable" } }), /invalid or unsuccessful/);
  });

  it("fails closed when positive totals have missing or malformed vulnerability entries", () => {
    const totals = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 };

    assert.throws(() => evaluateAudit({ metadata: { vulnerabilities: totals }, vulnerabilities: {} }), /invalid/);
    assert.throws(
      () => evaluateAudit({ metadata: { vulnerabilities: totals }, vulnerabilities: { minimatch: null } }),
      /invalid/,
    );
  });
});
