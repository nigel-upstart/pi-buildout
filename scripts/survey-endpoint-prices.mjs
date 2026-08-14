#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

import { classifyCacheWriteRate } from "../extensions/router/core/endpoint-cost.ts";
import { canonicalModelId } from "../extensions/router/core/scope.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(root, "extensions", "router", "core", "policy.ts");
const registryPackagePath = join(root, "node_modules", "@earendil-works", "pi-ai", "package.json");
const registryPath = join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logicalModelsFromPolicy(source) {
  const declaration = /const MODEL_VENDOR:[^=]+=[^{]*\{(?<body>[\s\S]*?)\n\};/u.exec(source);
  if (!declaration?.groups?.body) throw new Error("could not find the MODEL_VENDOR declaration in core/policy.ts");

  const entries = [...declaration.groups.body.matchAll(/^\s*"(?<modelId>[^"]+)":\s*"(?<vendor>[^"]+)",\s*$/gmu)].map(
    ({ groups }) => ({ logicalModelId: groups.modelId, vendor: groups.vendor }),
  );
  // Line-comment lines are skipped so an entry may carry a note beside it, which the policy does for
  // any model that is declared but deliberately unroutable. Everything else still fails closed: the
  // count check below is what stops this parser from silently surveying a subset of the real table.
  const unaccountedLines = declaration.groups.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  if (entries.length !== unaccountedLines.length) {
    throw new Error("MODEL_VENDOR contains syntax the deterministic survey parser does not recognize");
  }
  return entries.sort((left, right) => compareText(left.logicalModelId, right.logicalModelId));
}

function round(value) {
  return Number(value.toFixed(6));
}

function ratio(value, input) {
  return input === 0 ? null : round(value / input);
}

function endpointRecord(provider, model) {
  const { input, output, cacheRead, cacheWrite, tiers } = model.cost;
  return {
    provider,
    registryId: model.id,
    canonicalId: canonicalModelId(model.id),
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWriteClassification: classifyCacheWriteRate({ cacheRead, cacheWrite }),
    cacheReadToInput: ratio(cacheRead, input),
    cacheWriteToInput: ratio(cacheWrite, input),
    priceTierCount: tiers?.length ?? 0,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
    blendedCost: round(0.25 * input + 0.75 * output),
  };
}

const policySource = await readFile(policyPath, "utf8");
const logicalModels = logicalModelsFromPolicy(policySource);
const registryPackage = JSON.parse(await readFile(registryPackagePath, "utf8"));
if (typeof registryPackage.version !== "string" || registryPackage.version.length === 0) {
  throw new TypeError("installed @earendil-works/pi-ai package must declare a version");
}
const { MODELS } = await import(pathToFileURL(registryPath).href);
const registryEndpoints = Object.entries(MODELS)
  .flatMap(([provider, models]) =>
    (Array.isArray(models) ? models : Object.values(models)).map((model) => ({ provider, model })),
  )
  .sort((left, right) => compareText(left.provider, right.provider) || compareText(left.model.id, right.model.id));

const survey = {
  schemaVersion: 1,
  registryPackage: "@earendil-works/pi-ai",
  registryVersion: registryPackage.version,
  registrySource: "node_modules/@earendil-works/pi-ai/dist/models.generated.js",
  policySource: "extensions/router/core/policy.ts#MODEL_VENDOR",
  models: logicalModels.map(({ logicalModelId, vendor }) => ({
    logicalModelId,
    vendor,
    endpoints: registryEndpoints
      .filter(({ model }) => canonicalModelId(model.id) === logicalModelId)
      .map(({ provider, model }) => endpointRecord(provider, model)),
  })),
};

process.stdout.write(`${JSON.stringify(survey, null, 2)}\n`);
