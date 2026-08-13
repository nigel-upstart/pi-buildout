import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import { formatSingleAttemptEvidence, generateSingleAttemptEvidence } from "./generate-single-attempt-evidence.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "single-attempt-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function failedGeneratorCommand(arguments_) {
  let failure;
  try {
    await execFileAsync(process.execPath, ["scripts/generate-single-attempt-evidence.mjs", ...arguments_], {
      cwd: new URL("..", import.meta.url),
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "generator command should fail");
  assert.equal(failure.code, 1);
  return failure;
}

async function writeSyntheticCorpus() {
  const corpus = await temporaryDirectory();
  const rawDirectory = join(corpus, "swebench_multilingual", "raw");
  const derivedDirectory = join(corpus, "swebench_multilingual", "derived");
  await Promise.all([mkdir(rawDirectory, { recursive: true }), mkdir(derivedDirectory, { recursive: true })]);

  const tags = [
    "minimax-m2.5",
    "kimi-k2.5",
    "glm-5",
    "deepseek-v3.2",
    "Kimi-K2-Thinking",
    "claude-opus-4-6",
    "claude-4-5-opus",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "gpt-oss-120b",
  ];
  const results = [
    {
      tags: ["Model:minimax-m2.5"],
      resolved: "not numeric",
      name: "must be skipped",
    },
    ...tags.map((tag, index) => ({
      tags: ["Harness:mini-swe-agent", `Model: ${tag}`],
      resolved: index === 0 ? 75.555 : index === 1 ? 3.125 : 50 + index,
      instance_cost: index === 0 ? 1.2345678 : index === 1 ? 0.0078125 : index / 10,
      instance_calls: index === 0 ? 10.5555 : index === 1 ? 10.0625 : 20 + index,
      per_instance_details: { first: { resolved: true }, second: { resolved: false } },
      name: `Synthetic ${tag}`,
      date: "2026-01-02",
    })),
    {
      tags: ["Model:minimax-m2.5"],
      resolved: 1,
      instance_cost: 99,
      instance_calls: 99,
      per_instance_details: {},
      name: "later duplicate must not win",
      date: "2026-01-03",
    },
  ];
  await writeFile(
    join(rawDirectory, "leaderboard-data.json"),
    JSON.stringify([
      { name: "Test", results: [] },
      { name: "Verified", results },
    ]),
  );

  const csv = [
    "name,model_tag,org_tag,vendor,model_version,generation_status,language,n_instances,n_resolved,resolve_rate,mean_cost_usd,cost_per_resolved_usd,median_api_calls",
    '"Synthetic, quoted",minimax-2.5,MiniMax,minimax,2.5,keep,JS/TS,7,5,0.714285714,1.0,2.3456789,12.3456',
    "Synthetic Claude,claude-opus-4-6,Anthropic,anthropic,4.6,keep,C,3,2,0.6666666667,1.0,,",
    "Ignored,unknown-model,Unknown,unknown,1,keep,Go,1,1,1,1,1,1",
  ].join("\r\n");
  await writeFile(join(derivedDirectory, "per_language_resolve.csv"), csv);
  return corpus;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("single-attempt evidence generator", () => {
  it("ports the mappings, first-valid-row selection, row shape, and rounding against a synthetic corpus", async () => {
    const evidence = await generateSingleAttemptEvidence(await writeSyntheticCorpus());

    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.capturedAt, "2026-08-13");
    assert.deepEqual(
      evidence.rows.map(({ modelId }) => modelId),
      [
        "claude-haiku-4-5",
        "claude-opus-4-5",
        "claude-opus-4-6",
        "claude-sonnet-4-5",
        "deepseek-v3.2",
        "glm-5",
        "gpt-oss-120b",
        "kimi-k2-thinking",
        "kimi-k2.5",
        "minimax-m2.5",
      ],
    );

    const minimax = evidence.rows.find(({ modelId }) => modelId === "minimax-m2.5");
    assert.deepEqual(minimax, {
      modelId: "minimax-m2.5",
      scoped: true,
      effort: "high",
      verified: {
        nInstances: 2,
        resolveRate: 0.7556,
        costPerTaskUsd: 1.234568,
        medianApiCalls: 10.556,
        submission: "Synthetic minimax-m2.5",
        date: "2026-01-02",
      },
      byLanguage: {
        javascript_typescript: {
          nInstances: 7,
          resolveRate: 0.7143,
          costPerResolvedUsd: 2.345679,
          medianApiCalls: 12.346,
        },
      },
    });

    const kimi = evidence.rows.find(({ modelId }) => modelId === "kimi-k2.5");
    assert.deepEqual(
      {
        resolveRate: kimi.verified.resolveRate,
        costPerTaskUsd: kimi.verified.costPerTaskUsd,
        medianApiCalls: kimi.verified.medianApiCalls,
      },
      { resolveRate: 0.0312, costPerTaskUsd: 0.007812, medianApiCalls: 10.062 },
      "exact decimal midpoints must use Python's ties-to-even rounding",
    );

    const claude = evidence.rows.find(({ modelId }) => modelId === "claude-opus-4-6");
    assert.equal(claude.scoped, false);
    assert.deepEqual(claude.byLanguage.c, {
      nInstances: 3,
      resolveRate: 0.6667,
      costPerResolvedUsd: null,
      medianApiCalls: null,
    });
  });

  it("preserves Python float spellings when formatting generated JSON", async () => {
    const rendered = await formatSingleAttemptEvidence({
      nInstances: 60,
      resolveRate: 1,
      costPerTaskUsd: 2,
      costPerResolvedUsd: 3,
      medianApiCalls: 60,
    });

    assert.match(rendered, /"nInstances": 60,/u);
    assert.match(rendered, /"resolveRate": 1\.0,/u);
    assert.match(rendered, /"costPerTaskUsd": 2\.0,/u);
    assert.match(rendered, /"costPerResolvedUsd": 3\.0,/u);
    assert.match(rendered, /"medianApiCalls": 60\.0/u);
  });

  it("reports an unavailable corpus without failing --check", async () => {
    const missingCorpus = join(await temporaryDirectory(), "does-not-exist");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/generate-single-attempt-evidence.mjs", "--check", "--corpus", missingCorpus],
      { cwd: new URL("..", import.meta.url) },
    );

    assert.match(`${stdout}${stderr}`, /corpus unavailable.*artifact not verified/iu);
  });

  it("fails --check when the corpus root exists but a required input is missing", async () => {
    const partialCorpus = await temporaryDirectory();
    const rawDirectory = join(partialCorpus, "swebench_multilingual", "raw");
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(join(rawDirectory, "leaderboard-data.json"), "[]");

    const failure = await failedGeneratorCommand(["--check", "--corpus", partialCorpus]);
    assert.match(failure.stderr, /per_language_resolve\.csv/u);
    assert.doesNotMatch(failure.stderr, /artifact not verified/iu);
  });

  it("rejects an option in place of the --corpus path", async () => {
    for (const option of ["--bogus", "-x"]) {
      const failure = await failedGeneratorCommand(["--check", "--corpus", option]);
      assert.match(failure.stderr, /--corpus requires a path/u);
      assert.doesNotMatch(failure.stderr, /artifact not verified/iu);
    }
  });

  it("exits nonzero with row-and-field details when a generated fixture drifts from the artifact", async () => {
    const corpus = await writeSyntheticCorpus();
    const failure = await failedGeneratorCommand(["--check", "--corpus", corpus]);

    assert.match(failure.stderr, /Single-attempt evidence differs/u);
    assert.match(failure.stderr, /rows\[claude-haiku-4-5\]\.verified\.nInstances: expected 500, actual 2/u);
  });
});
