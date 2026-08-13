#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(root, "specs", "routing-layer", "single-attempt-evidence-2026-08-13.json");
const defaultCorpusPath = "/Users/nigel.stuke/outputs/llm-effectiveness";
const corpusEnvironmentVariable = "SINGLE_ATTEMPT_EVIDENCE_CORPUS";

// This is a historical capture date, not a generation timestamp. Pinning it makes regeneration and --check stable
// instead of silently relabeling the same source observations with the date on which this script happens to run.
const capturedAt = "2026-08-13";

const wantedVerified = new Map([
  ["minimax-m2.5", ["minimax-m2.5", "high"]],
  ["kimi-k2.5", ["kimi-k2.5", "high"]],
  ["glm-5", ["glm-5", "high"]],
  ["deepseek-v3.2", ["deepseek-v3.2", "high"]],
  ["Kimi-K2-Thinking", ["kimi-k2-thinking", "high"]],
  ["claude-opus-4-6", ["claude-opus-4-6", "high"]],
  ["claude-4-5-opus", ["claude-opus-4-5", "high"]],
  ["claude-sonnet-4-5-20250929", ["claude-sonnet-4-5", "high"]],
  ["claude-haiku-4-5-20251001", ["claude-haiku-4-5", "high"]],
  ["gpt-oss-120b", ["gpt-oss-120b", "high"]],
]);

const multilingualModelIds = new Map([
  ["minimax-2.5", "minimax-m2.5"],
  ["kimi-k2.5", "kimi-k2.5"],
  ["glm-5", "glm-5"],
  ["deepseek-v3.2", "deepseek-v3.2"],
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["claude-opus-4-5-20251101", "claude-opus-4-5"],
  ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
]);

const languageKeys = new Map([
  ["Go", "go"],
  ["Ruby", "ruby"],
  ["JS/TS", "javascript_typescript"],
  ["Java", "java"],
  ["Rust", "rust"],
  ["C", "c"],
  ["C++", "cpp"],
  ["PHP", "php"],
]);

const scopedModelIds = new Set(["minimax-m2.5", "kimi-k2.5", "glm-5", "deepseek-v3.2", "kimi-k2-thinking"]);
const pythonFloatFields = new Set(["resolveRate", "costPerTaskUsd", "costPerResolvedUsd", "medianApiCalls"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Python's round(float, places) rounds the exact IEEE-754 value to nearest-even. Number.toFixed rounds midpoint
// examples such as 10.0625 differently, so use the float's exact binary rational to preserve the source generator's
// behavior rather than relying on decimal string conversion.
function round(value, places) {
  if (!Number.isFinite(value) || Object.is(value, -0)) return value;

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  const factor = 10n ** BigInt(places);
  let numerator = significand * factor;
  let denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);

  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const comparison = remainder * 2n - denominator;
  if (comparison > 0n || (comparison === 0n && rounded % 2n !== 0n)) rounded += 1n;

  const result = Number(rounded) / Number(factor);
  return value < 0 ? -result : result;
}

function numericOrNull(value, places) {
  return typeof value === "number" ? round(value, places) : null;
}

function modelTag(row) {
  const tag = row.tags?.find((value) => typeof value === "string" && value.startsWith("Model:"));
  return tag?.slice("Model:".length).trim() ?? "";
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("unterminated quoted field in per_language_resolve.csv");
  if (field !== "" || record.length > 0) {
    record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    records.push(record);
  }
  if (records.length === 0) return [];

  const [headers, ...body] = records;
  return body
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function verifiedRows(leaderboard) {
  if (!Array.isArray(leaderboard)) throw new TypeError("leaderboard-data.json must contain an array of splits");
  const verified = leaderboard.find((split) => split?.name === "Verified")?.results;
  if (!Array.isArray(verified)) throw new TypeError('leaderboard-data.json must contain a "Verified" results array');

  const rows = new Map();
  for (const sourceRow of verified) {
    const wanted = wantedVerified.get(modelTag(sourceRow));
    if (!wanted) continue;
    const [modelId, effort] = wanted;
    if (rows.has(modelId) || typeof sourceRow.resolved !== "number") continue;

    const details = sourceRow.per_instance_details ?? {};
    rows.set(modelId, {
      effort,
      nInstances: typeof details === "object" ? Object.keys(details).length : 0,
      resolveRate: round(sourceRow.resolved / 100, 4),
      costPerTaskUsd: numericOrNull(sourceRow.instance_cost, 6),
      medianApiCalls: numericOrNull(sourceRow.instance_calls, 3),
      submission: sourceRow.name ?? null,
      date: sourceRow.date ?? null,
    });
  }

  const missing = [...new Set([...wantedVerified.values()].map(([modelId]) => modelId))]
    .filter((modelId) => !rows.has(modelId))
    .sort(compareText);
  if (missing.length > 0) throw new Error(`missing verified rows: ${JSON.stringify(missing)}`);
  return rows;
}

function multilingualRows(csvText) {
  const rows = new Map();
  for (const sourceRow of parseCsv(csvText)) {
    const modelId = multilingualModelIds.get(sourceRow.model_tag);
    const language = languageKeys.get(sourceRow.language);
    if (!modelId || !language) continue;

    const languages = rows.get(modelId) ?? new Map();
    languages.set(language, {
      nInstances: Number.parseInt(sourceRow.n_instances, 10),
      resolveRate: round(Number(sourceRow.resolve_rate), 4),
      costPerResolvedUsd:
        sourceRow.cost_per_resolved_usd === "" ? null : round(Number(sourceRow.cost_per_resolved_usd), 6),
      medianApiCalls: sourceRow.median_api_calls === "" ? null : round(Number(sourceRow.median_api_calls), 3),
    });
    rows.set(modelId, languages);
  }
  return rows;
}

export async function generateSingleAttemptEvidence(corpusPath) {
  const leaderboardPath = join(corpusPath, "swebench_multilingual", "raw", "leaderboard-data.json");
  const perLanguagePath = join(corpusPath, "swebench_multilingual", "derived", "per_language_resolve.csv");
  const [leaderboardText, perLanguageText] = await Promise.all([
    readFile(leaderboardPath, "utf8"),
    readFile(perLanguagePath, "utf8"),
  ]);
  const verified = verifiedRows(JSON.parse(leaderboardText));
  const multilingual = multilingualRows(perLanguageText);
  const modelIds = [...new Set([...verified.keys(), ...multilingual.keys()])].sort(compareText);

  return {
    schemaVersion: 1,
    capturedAt,
    construct: {
      sourceA:
        "SWE-bench Verified, mini-swe-agent, single attempt per instance. resolveRate is a deterministic verifier outcome, never an acceptance rate.",
      sourceB: "SWE-bench Multilingual, mini-swe-agent, single attempt, 300 tasks across 8 language splits.",
      costBasis:
        "Each submission's own reported cost at whatever route it ran on. Not a Bedrock rate and not comparable to endpoint pricing without rescaling.",
      limits:
        "Single attempt, so no regression-break, partial-credit, repeat-determinism, wall-time or peak-context measurement exists. These rows must never be scored by the cost-to-done model.",
    },
    rows: modelIds.map((modelId) => {
      const row = { modelId, scoped: scopedModelIds.has(modelId) };
      const verifiedRow = verified.get(modelId);
      if (verifiedRow) {
        const { effort, ...values } = verifiedRow;
        row.effort = effort;
        row.verified = values;
      } else {
        row.effort = "high";
      }
      const languages = multilingual.get(modelId);
      if (languages) {
        row.byLanguage = Object.fromEntries([...languages].sort(([left], [right]) => compareText(left, right)));
      }
      return row;
    }),
  };
}

function pythonCompatibleJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /^(\s+)"(?<field>resolveRate|costPerTaskUsd|costPerResolvedUsd|medianApiCalls)": (?<value>-?\d+)(?<comma>,?)$/gmu,
    (line, _indent, field, numericValue, comma) =>
      pythonFloatFields.has(field) ? line.replace(`${numericValue}${comma}`, `${numericValue}.0${comma}`) : line,
  );
}

export async function formatSingleAttemptEvidence(evidence) {
  return format(`${pythonCompatibleJson(evidence)}\n`, { filepath: artifactPath });
}

function shown(value) {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

function compareValues(expected, actual, path, differences) {
  if (Object.is(expected, actual)) return;
  if (path === "rows" && Array.isArray(expected) && Array.isArray(actual)) {
    const expectedRows = new Map(expected.map((row) => [row.modelId, row]));
    const actualRows = new Map(actual.map((row) => [row.modelId, row]));
    const modelIds = [...new Set([...expectedRows.keys(), ...actualRows.keys()])].sort(compareText);
    for (const modelId of modelIds) {
      compareValues(expectedRows.get(modelId), actualRows.get(modelId), `rows[${modelId}]`, differences);
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      compareValues(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareText);
    for (const key of keys) {
      compareValues(expected[key], actual[key], path === "" ? key : `${path}.${key}`, differences);
    }
    return;
  }
  differences.push(`${path}: expected ${shown(expected)}, actual ${shown(actual)}`);
}

function evidenceDifferences(expected, actual) {
  const differences = [];
  compareValues(expected, actual, "", differences);
  return differences;
}

function parseArguments(arguments_) {
  let check = false;
  let corpus;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--corpus") {
      corpus = arguments_[index + 1];
      if (!corpus || corpus.startsWith("-")) throw new Error("--corpus requires a path");
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return {
    check,
    corpusPath: resolve(corpus ?? process.env[corpusEnvironmentVariable] ?? defaultCorpusPath),
  };
}

async function corpusRootIsUnavailable(corpusPath) {
  try {
    const metadata = await stat(corpusPath);
    if (!metadata.isDirectory()) throw new TypeError(`corpus path is not a directory: ${corpusPath}`);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
    throw error;
  }
}

async function main() {
  const { check, corpusPath } = parseArguments(process.argv.slice(2));
  if (check && (await corpusRootIsUnavailable(corpusPath))) {
    // The checked-in JSON is authoritative for the router. This script verifies provenance only when the private
    // research corpus is present, so CI and developers without that corpus must still be able to run npm run check.
    // Once the corpus root exists, however, missing required inputs are corruption and must fail rather than skip.
    console.warn(`Single-attempt evidence corpus unavailable at ${corpusPath}; artifact not verified.`);
    return;
  }

  const generated = await generateSingleAttemptEvidence(corpusPath);
  const generatedText = await formatSingleAttemptEvidence(generated);
  if (!check) {
    await writeFile(artifactPath, generatedText);
    console.log(`Generated ${artifactPath}`);
    return;
  }

  const checkedInText = await readFile(artifactPath, "utf8");
  if (checkedInText === generatedText) {
    console.log("Single-attempt evidence matches the checked-in artifact.");
    return;
  }

  console.error("Single-attempt evidence differs from the checked-in artifact:");
  try {
    const differences = evidenceDifferences(JSON.parse(checkedInText), generated);
    if (differences.length === 0) {
      console.error("- values agree, but formatting or key ordering differs");
    } else {
      for (const difference of differences.slice(0, 50)) console.error(`- ${difference}`);
      if (differences.length > 50) console.error(`- ... ${differences.length - 50} more differences`);
    }
  } catch (error) {
    console.error(`- checked-in artifact is not valid JSON: ${error.message}`);
  }
  console.error(`Run: node ${fileURLToPath(import.meta.url)} --corpus ${corpusPath}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
