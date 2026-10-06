import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAudit } from "./check-audit.mjs";

const bracesAdvisoryUrl = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const bracesNodes = ["node_modules/braces"];

function auditReport() {
  return {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 2, high: 5, critical: 0, total: 7 } },
    vulnerabilities: {
      braces: {
        name: "braces",
        severity: "high",
        nodes: [...bracesNodes],
        via: [{ severity: "high", url: bracesAdvisoryUrl }],
      },
      micromatch: {
        name: "micromatch",
        severity: "high",
        nodes: ["node_modules/micromatch"],
        via: ["braces"],
      },
      "fast-glob": {
        name: "fast-glob",
        severity: "high",
        nodes: ["node_modules/fast-glob"],
        via: ["micromatch"],
      },
      globby: {
        name: "globby",
        severity: "high",
        nodes: ["node_modules/globby"],
        via: ["fast-glob"],
      },
      "markdownlint-cli2": {
        name: "markdownlint-cli2",
        severity: "high",
        nodes: ["node_modules/markdownlint-cli2"],
        via: ["globby", "js-yaml", "markdown-it", "micromatch"],
      },
      "js-yaml": {
        name: "js-yaml",
        severity: "moderate",
        nodes: ["node_modules/js-yaml"],
        via: [{ severity: "moderate", url: "https://github.com/advisories/GHSA-r3ph-w7gj-g6xm" }],
      },
      "markdown-it": {
        name: "markdown-it",
        severity: "moderate",
        nodes: ["node_modules/markdown-it"],
        via: [{ severity: "moderate", url: "https://github.com/advisories/GHSA-253c-mchw-3w2r" }],
      },
    },
  };
}

describe("evaluateAudit", () => {
  it("accepts reviewed findings derived from the allowlisted high advisory despite moderate sources", () => {
    const result = evaluateAudit(auditReport());

    assert.equal(result.unexplained.length, 0);
    assert.deepEqual(
      result.acceptedAdvisories.map(({ advisoryUrl }) => advisoryUrl),
      [bracesAdvisoryUrl],
    );
    assert.deepEqual(result.accepted.map(({ name }) => name).sort(), [
      "braces",
      "fast-glob",
      "globby",
      "markdownlint-cli2",
      "micromatch",
    ]);
  });

  it("fails closed when a derived finding moves to a different installed path", () => {
    const report = auditReport();
    report.vulnerabilities.micromatch.nodes.push("node_modules/new-consumer/node_modules/micromatch");

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["fast-glob", "globby", "markdownlint-cli2", "micromatch"],
    );
  });

  it("fails closed when a derived source edge changes", () => {
    const report = auditReport();
    report.vulnerabilities["fast-glob"].via.push("braces");

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["fast-glob", "globby", "markdownlint-cli2"],
    );
  });

  it("does not authorize a derived path through an unrelated allowlist rule", () => {
    const report = {
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0, total: 3 } },
      vulnerabilities: {
        braces: {
          name: "braces",
          severity: "high",
          nodes: ["node_modules/braces"],
          via: [{ severity: "high", url: bracesAdvisoryUrl }],
        },
        "other-root": {
          name: "other-root",
          severity: "high",
          nodes: ["node_modules/other-root"],
          via: [{ severity: "high", url: "https://github.com/advisories/GHSA-other-root" }],
        },
        micromatch: {
          name: "micromatch",
          severity: "high",
          nodes: ["node_modules/micromatch"],
          via: ["braces"],
        },
      },
    };
    const allowlist = [
      { package: "braces", advisoryUrl: bracesAdvisoryUrl, nodePaths: ["node_modules/braces"] },
      {
        package: "other-root",
        advisoryUrl: "https://github.com/advisories/GHSA-other-root",
        nodePaths: ["node_modules/other-root"],
        derivedFindings: {
          micromatch: { nodePaths: ["node_modules/micromatch"], sources: ["braces"] },
        },
      },
    ];

    assert.deepEqual(
      evaluateAudit(report, allowlist).unexplained.map(({ name }) => name),
      ["micromatch"],
    );
  });

  it("fails closed when a derived source name is missing from the audit report", () => {
    const report = auditReport();
    delete report.vulnerabilities["markdown-it"];
    report.metadata.vulnerabilities.moderate = 1;
    report.metadata.vulnerabilities.total -= 1;

    assert.deepEqual(
      evaluateAudit(report).unexplained.map(({ name }) => name),
      ["markdownlint-cli2"],
    );
  });

  it("fails closed when a derived finding also depends on an unreviewed high vulnerability", () => {
    const report = auditReport();
    report.metadata.vulnerabilities.high += 1;
    report.metadata.vulnerabilities.total += 1;
    report.vulnerabilities["markdownlint-cli2"].via.push("unreviewed");
    report.vulnerabilities.unreviewed = {
      name: "unreviewed",
      severity: "high",
      nodes: ["node_modules/unreviewed"],
      via: [{ severity: "high", url: "https://github.com/advisories/GHSA-unreviewed" }],
    };

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["markdownlint-cli2", "unreviewed"],
    );
  });

  it("fails closed when npm groups a new advisory with the reviewed advisory", () => {
    const report = auditReport();
    report.vulnerabilities.braces.via.push({
      severity: "critical",
      url: "https://github.com/advisories/GHSA-unreviewed",
    });

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["braces", "fast-glob", "globby", "markdownlint-cli2", "micromatch"],
    );
  });

  it("fails closed when a reviewed advisory appears at a different path", () => {
    const report = auditReport();
    report.vulnerabilities.braces.nodes.push("node_modules/new-consumer/node_modules/braces");

    assert.deepEqual(
      evaluateAudit(report)
        .unexplained.map(({ name }) => name)
        .sort(),
      ["braces", "fast-glob", "globby", "markdownlint-cli2", "micromatch"],
    );
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
