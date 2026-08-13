import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { classifyCacheWriteRate } from "../extensions/router/core/endpoint-cost.ts";

const execFileAsync = promisify(execFile);

describe("endpoint price survey", () => {
  it("emits explicit cache-write classifications for every surveyed endpoint", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/survey-endpoint-prices.mjs"], {
      cwd: new URL("..", import.meta.url),
      maxBuffer: 4 * 1024 * 1024,
    });
    const survey = JSON.parse(stdout);
    const endpoints = survey.models.flatMap((model) => model.endpoints);
    assert.ok(endpoints.length > 0);
    for (const endpoint of endpoints) {
      assert.equal(
        endpoint.cacheWriteClassification,
        classifyCacheWriteRate({ cacheRead: endpoint.cacheRead, cacheWrite: endpoint.cacheWrite }),
        `${endpoint.provider}/${endpoint.registryId}`,
      );
    }

    const sol = survey.models.find((model) => model.logicalModelId === "gpt-5.6-sol");
    assert.ok(sol, "the policy survey must include gpt-5.6-sol");
    const exceptions = sol.endpoints
      .filter((endpoint) => endpoint.cacheWriteClassification === "no_write_line_item")
      .map((endpoint) => endpoint.provider)
      .sort();
    assert.deepEqual(exceptions, ["cloudflare-ai-gateway"]);
  });
});
