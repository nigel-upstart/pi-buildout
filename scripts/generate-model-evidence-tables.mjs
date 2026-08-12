#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

const BEGIN_MARKER = "<!-- BEGIN GENERATED BENCHMARK TABLES -->";
const END_MARKER = "<!-- END GENERATED BENCHMARK TABLES -->";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = join(root, "specs", "routing-layer", "model-evidence-2026-07-25.json");
const documentPath = join(root, "specs", "routing-layer", "model-evidence-2026-08-11.md");
const effortOrder = new Map(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value, index) => [value, index]),
);

function percent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function decimal(value, digits = 1) {
  return value == null ? "—" : value.toFixed(digits);
}

function integer(value) {
  return value == null ? "—" : Math.round(value).toLocaleString("en-US");
}

function money(value) {
  return value == null ? "—" : `$${value.toFixed(2)}`;
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, divider, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRows(rows) {
  return [...rows].sort(
    (left, right) =>
      compareText(left.modelId, right.modelId) ||
      (effortOrder.get(left.effort) ?? Number.MAX_SAFE_INTEGER) -
        (effortOrder.get(right.effort) ?? Number.MAX_SAFE_INTEGER),
  );
}

function capabilityTable(rows) {
  return markdownTable(
    [
      "Model",
      "Effort",
      "Trials",
      "Pass",
      "Hard pass",
      "Regression break",
      "Partial on failure",
      "Repeat all-pass",
      "Repeat flaky",
    ],
    rows.map(({ modelId, effort, deepswe }) => [
      `\`${modelId}\``,
      `\`${effort}\``,
      integer(deepswe.nTrials),
      percent(deepswe.passRate),
      percent(deepswe.hardTaskPassRate),
      percent(deepswe.regressionBreakRate),
      percent(deepswe.partialCreditOnFailure),
      percent(deepswe.repeatAllPassRate),
      percent(deepswe.repeatFlakyRate),
    ]),
  );
}

function operationsTable(rows) {
  return markdownTable(
    [
      "Model",
      "Effort",
      "Median steps",
      "Median s",
      "p90 s",
      "p90 context",
      "Overflow",
      "Timeout",
      "Routing error",
      "Cost/pass",
    ],
    rows.map(({ modelId, effort, deepswe }) => [
      `\`${modelId}\``,
      `\`${effort}\``,
      decimal(deepswe.medianSteps),
      integer(deepswe.medianWallTimeSeconds),
      integer(deepswe.p90WallTimeSeconds),
      integer(deepswe.p90PeakContextTokens),
      percent(deepswe.contextOverflowRate),
      percent(deepswe.timeoutRate),
      percent(deepswe.routingErrorRate),
      money(deepswe.costPerPassUsd),
    ]),
  );
}

function corroborationTable(rows) {
  return markdownTable(
    [
      "Model",
      "Effort",
      "Cursor score",
      "Cursor cost/task",
      "Cursor rank",
      "Consensus low",
      "Consensus best",
      "Consensus high",
      "Sources",
    ],
    rows.map(({ modelId, effort, cursorbench, consensus }) => [
      `\`${modelId}\``,
      `\`${effort}\``,
      cursorbench ? `${decimal(cursorbench.scorePct)}%` : "—",
      cursorbench ? money(cursorbench.costPerTaskUsd) : "—",
      cursorbench ? integer(cursorbench.rank) : "—",
      consensus ? decimal(consensus.performanceLow, 2) : "—",
      consensus ? decimal(consensus.performanceBest, 2) : "—",
      consensus ? decimal(consensus.performanceHigh, 2) : "—",
      consensus ? integer(consensus.sourceCount) : "—",
    ]),
  );
}

function languageTable(rows) {
  const languageRows = rows.flatMap(({ modelId, effort, byLanguage }) =>
    Object.entries(byLanguage)
      .sort(([left], [right]) => compareText(left, right))
      .map(([language, values]) => [
        `\`${modelId}\``,
        `\`${effort}\``,
        `\`${language}\``,
        percent(values.passRate),
        percent(values.hardTaskPassRate),
        percent(values.regressionBreakRate),
        integer(values.medianWallTimeSeconds),
      ]),
  );
  return markdownTable(
    ["Model", "Effort", "Bucket", "Pass", "Hard pass", "Regression break", "Median s"],
    languageRows,
  );
}

function frugalityTable(frugality) {
  return markdownTable(
    [
      "Model",
      "Effort",
      "Median API calls",
      "Resolve rate",
      "Go calls",
      "Python calls",
      "TypeScript calls",
      "Ruby calls",
    ],
    sortedRows(frugality.rows).map(({ modelId, effort, medianApiCalls, resolveRate, perLanguageMedianApiCalls }) => [
      `\`${modelId}\``,
      `\`${effort}\``,
      decimal(medianApiCalls),
      percent(resolveRate),
      decimal(perLanguageMedianApiCalls.go),
      decimal(perLanguageMedianApiCalls.python),
      decimal(perLanguageMedianApiCalls.typescript),
      decimal(perLanguageMedianApiCalls.ruby),
    ]),
  );
}

function generatedTables(data) {
  const rows = sortedRows(data.rows);
  return [
    BEGIN_MARKER,
    "",
    "### Agentic capability and reliability",
    "",
    capabilityTable(rows),
    "",
    "### Agentic operations and cost per solved benchmark task",
    "",
    operationsTable(rows),
    "",
    "### CursorBench and cross-source consensus",
    "",
    corroborationTable(rows),
    "",
    "### Per-language and stack-proxy slices",
    "",
    languageTable(rows),
    "",
    "### Step-frugality evidence",
    "",
    `Source construct: ${data.frugality.construct}.`,
    "",
    frugalityTable(data.frugality),
    "",
    END_MARKER,
  ].join("\n");
}

function replaceGeneratedSection(document, generated) {
  const begin = document.indexOf(BEGIN_MARKER);
  const end = document.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error(`expected one ordered ${BEGIN_MARKER}/${END_MARKER} marker pair`);
  }
  if (
    document.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length) !== -1 ||
    document.indexOf(END_MARKER, end + END_MARKER.length) !== -1
  ) {
    throw new Error("generated-table markers must each occur exactly once");
  }
  return `${document.slice(0, begin)}${generated}${document.slice(end + END_MARKER.length)}`;
}

const data = JSON.parse(await readFile(dataPath, "utf8"));
if (!Array.isArray(data.rows) || !Array.isArray(data.frugality?.rows)) {
  throw new TypeError("evidence JSON must contain rows and frugality.rows arrays");
}
const document = await readFile(documentPath, "utf8");
const generated = generatedTables(data);
const expected = await format(replaceGeneratedSection(document, generated), { filepath: documentPath });

if (process.argv.slice(2).includes("--check")) {
  if (document !== expected) {
    console.error(`Generated benchmark tables are stale. Run: node ${fileURLToPath(import.meta.url)}`);
    process.exitCode = 1;
  }
} else {
  await writeFile(documentPath, expected);
}
